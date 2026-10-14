import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import type { McpToolDefinition } from '../../src/mcp/protocol.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const officialPath = fileURLToPath(new URL('../fixtures/mcp/playwright-0.0.83-screenshot.json', import.meta.url));
const official: McpToolDefinition = JSON.parse(readFileSync(officialPath, 'utf8'));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; jest.restoreAllMocks(); });

describe('MCP schema validation at runtime use', () => {
  it('isolates repeated IDs across tools, services and fresh starts while preserving both dialects and local refs', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-schema-owner-');
    mkdirSync(join(root, '.saivage'));
    const calls: unknown[] = [];
    const schemas = [
      {
        $id: 'https://example.com/shared',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        definitions: { value: { type: 'string' } },
        properties: { value: { $ref: '#/definitions/value' } },
        required: ['value'],
        additionalProperties: false,
        'x-source': 'draft7',
      },
      {
        $id: 'https://example.com/shared',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { value: { type: 'integer' } },
        properties: { value: { $ref: '#/$defs/value' } },
        required: ['value'],
        unevaluatedProperties: false,
        'x-source': '2020',
      },
    ];
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      if (request.method === 'tools/call') calls.push(request.params);
      const bytes = JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'tools/list'
            ? {
                tools: [
                  ...schemas.map((inputSchema, i) => ({ name: `tool${i}`, inputSchema })),
                  { name: 'missing' },
                  { name: 'invalid', inputSchema: { type: 'object', required: 'not-an-array' } },
                  {
                    name: 'unsupported',
                    inputSchema: {
                      type: 'object',
                      $schema: 'https://example.com/unsupported-dialect',
                    },
                  },
                ],
              }
            : request.method === 'tools/call'
              ? { content: [] }
              : {},
      });
      const response = new Response(bytes, { headers: { 'content-type': 'application/json' } });
      response.json = async () => JSON.parse(bytes);
      return response;
    }) as typeof fetch;
    writeFileSync(
      join(root, '.saivage/saivage.yaml'),
      YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: {} }),
    );
    const registry = new ManagedProcessGroupRegistry();
    const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
    const manager = new McpManager({
      configAuthority: testConfigAuthority(root),
      processRunner: runner,
      mcpProcessRootScope: registry.createContainerScope(registry.rootScope, 'mcp'),
      eventLogger: { appendEventPrepared() {} } as never,
    });
    try {
      for (const name of ['one', 'two'])
        manager.registerServer(name, { transport: 'streamable-http', url: 'http://localhost/mcp' });
      for (let cycle = 0; cycle < 2; cycle++)
        for (const name of ['one', 'two']) {
          await manager.startServer(name);
          const binding = manager.getServerStatus(name)!.bindingId!;
          expect(
            manager
              .getServerTools(name)!
              .slice(0, 2)
              .map((t) => t.inputSchema),
          ).toEqual(schemas);
          expect(
            manager.getServerTools(name)!.find((t) => t.name === 'missing'),
          ).not.toHaveProperty('inputSchema');
          const beforeInvalid = calls.length;
          for (const [tool, reason] of [
            ['missing', 'schema_missing'],
            ['invalid', 'schema_compile_error'],
            ['unsupported', 'schema_unsupported'],
          ]) {
            await expect(manager.invokeTool(name, binding, tool!, {})).rejects.toMatchObject({
              data: { reason },
            });
          }
          expect(calls).toHaveLength(beforeInvalid);
          for (let i = 0; i < 2; i++) {
            await manager.invokeTool(name, binding, `tool${i}`, { value: i === 0 ? 'text' : 42 });
            const count = calls.length;
            await expect(
              manager.invokeTool(name, binding, `tool${i}`, { value: i === 0 ? 42 : 'text' }),
            ).rejects.toMatchObject({ data: { reason: 'validation_error' } });
            expect(calls).toHaveLength(count);
          }
          await manager.stopServer(name);
        }
      expect(calls).toHaveLength(8);
    } finally {
      await manager.cleanupForApplicationStop();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['stdio', 'streamable-http'] as const)(
    '%s retains exact discovery, validates pinned screenshot arguments before transport and refreshes changed-schema cache',
    async (transport) => {
      const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-schema-');
      mkdirSync(join(root, '.saivage'));
      const callsPath = join(root, 'calls.jsonl');
      writeFileSync(callsPath, '');
      const httpCalls: unknown[] = [];
      globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
        let result;
        if (request.method === 'initialize') result = { protocolVersion: '2025-06-18' };
        else if (request.method === 'tools/list') result = { tools: [official] };
        else {
          expect(request.method).toBe('tools/call');
          httpCalls.push(request.params);
          result = { content: [{ type: 'text', text: 'accepted' }] };
        }
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
        const response = new Response(body, { headers: { 'content-type': 'application/json' } });
        // Native Response.json parses in the host realm outside Jest's VM; keep
        // wire parsing in this test's realm, like the real non-VM runtime.
        response.json = async () => JSON.parse(body);
        return response;
      }) as typeof fetch;
      const config = transport === 'stdio'
        ? { transport, command: process.execPath, args: [fileURLToPath(new URL('../fixtures/mcp/schema-server.mjs', import.meta.url)), officialPath, callsPath] }
        : { transport, url: 'http://localhost/schema-mcp' };
      writeFileSync(join(root, '.saivage/saivage.yaml'), YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: { one: config } }));
      const registry = new ManagedProcessGroupRegistry();
      const scope = registry.createContainerScope(registry.rootScope, 'mcp');
      const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
      const events = { appendEventPrepared: jest.fn() };
      const manager = new McpManager({ configAuthority: testConfigAuthority(root), processRunner: runner, mcpProcessRootScope: scope, eventLogger: events as never });
      const calls = () => transport === 'stdio'
        ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        : httpCalls;
      try {
        expect(await manager.reconcilePersistedConfig()).toMatchObject({ converged: true });
        expect(manager.getServerTools('one')).toEqual([official]);
        for (const args of [{}, { scale: 'wrong' }, { scale: 'css', extra: true }]) {
          await expect(manager.invokeTool('one',
              manager.getServerStatus('one')!.bindingId!, official.name, args)).rejects.toMatchObject({
            data: { reason: 'validation_error' },
          });
        }
        expect(calls()).toHaveLength(0);
        expect(manager.getInvocationStats()).toEqual({});
        expect(events.appendEventPrepared).not.toHaveBeenCalled();
        const args = { scale: 'css', type: 'png' };
        await expect(manager.invokeTool('one',
            manager.getServerStatus('one')!.bindingId!, official.name, args)).resolves.toEqual({ content: [{ type: 'text', text: 'accepted' }] });
        expect(calls()).toEqual([{ name: official.name, arguments: args }]);
        expect(args).toEqual({ scale: 'css', type: 'png' });
        expect(manager.getServerTools('one')).toEqual([official]);

        // Change the discovered object itself: the existing (name,fingerprint) use cache
        // must not reuse the formerly compiled validator or a pruned schema projection.
        const tool = manager.getServerTools('one')![0]!;
        tool.inputSchema = {
          type: 'object', properties: { tuple: { type: 'array', prefixItems: [{ type: 'integer' }], items: false } },
          required: ['tuple'], unevaluatedProperties: false, 'x-discovery-extension': { preserved: true },
        };
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { tuple: [1] })).resolves.toBeDefined();
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { tuple: [1, 2] })).rejects.toMatchObject({ data: { reason: 'validation_error' } });
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { tuple: [1], extra: true })).rejects.toMatchObject({ data: { reason: 'validation_error' } });
        tool.inputSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { tuple: { type: 'array', items: [{ type: 'string' }], additionalItems: false } } };
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { tuple: ['one'] })).resolves.toBeDefined();
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { tuple: ['one', 'two'] })).rejects.toMatchObject({ data: { reason: 'validation_error' } });
        tool.inputSchema = { type: 'object', properties: { enabled: true, disabled: false }, 'x-external': true };
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { enabled: 1 })).resolves.toBeDefined();
        await expect(manager.invokeTool('one', manager.getServerStatus('one')!.bindingId!, official.name, { disabled: 1 })).rejects.toMatchObject({ data: { reason: 'validation_error' } });
        for (const inputSchema of [
          { type: 'object' as const, $schema: 'unsupported' },
          { type: 'object' as const, properties: { value: { $ref: 'https://example.invalid/schema' } } },
        ]) {
          tool.inputSchema = inputSchema;
          await expect(manager.invokeTool('one',
              manager.getServerStatus('one')!.bindingId!, official.name, {})).rejects.toMatchObject({ data: { reason: inputSchema.$schema ? 'schema_unsupported' : 'schema_compile_error' } });
        }
        expect(calls()).toHaveLength(4);
        expect(manager.getInvocationStats()[`one:${official.name}`]).toMatchObject({ total: 4, success: 4, error: 0 });
        expect(events.appendEventPrepared).toHaveBeenCalledTimes(4);
      } finally {
        // Remove only after actual owning containment succeeded.
        await manager.cleanupForApplicationStop();
        rmSync(root, { recursive: true });
      }
    }, 20_000,
  );
});
