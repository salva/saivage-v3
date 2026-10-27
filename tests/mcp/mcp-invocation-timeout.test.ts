import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { TimeoutError } from '../../src/mcp/errors.js';
import { createMcpToolInvocationInstallation } from '../../src/mcp/tool-invocation-installation.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-invocation-timeout-'));
  mkdirSync(join(root, '.saivage'));
  writeFileSync(join(root, '.saivage/saivage.yaml'), YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: {} }));
  const groups = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, groups, testApplicationFatalPort);
  const manager = new McpManager({ nativeGit: false, configAuthority: testConfigAuthority(root), processRunner: runner, mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger: { appendEventPrepared() {} } as never });
  const installation = createMcpToolInvocationInstallation();
  installation.installer.install(manager);
  const surface = new BoundAgentToolSet([resolveRuntimeTool('card', 'mcp_tool_call')]).bind({ scope: 'card', agentName: 'executor', projectRoot: root, mcpToolInvocation: installation.port } as never);
  return { root, manager, runner, surface, async close() { await manager.cleanupForApplicationStop(); rmSync(root, { recursive: true }); } };
}

// Real child-local session state and synchronous work: never blocks Jest's timer owner.
function sessionPeer(root: string, name: string) {
  const script = join(root, `${name}.cjs`);
  const wire = join(root, `${name}-wire.jsonl`);
  writeFileSync(wire, '');
  writeFileSync(script, `
const fs = require('node:fs');
const sessions = new Map();
let executions = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(wire)}, line+'\\n');
  if (r.method === 'initialize') return send(r.id, {});
  if (r.method === 'notifications/initialized') return;
  if (r.method === 'tools/list') return send(r.id, {tools:[{name:'session', inputSchema:{type:'object',properties:{action:{enum:['create','read','block']},session:{type:'string'},sentinel:{type:'string'}},required:['action','session'],additionalProperties:false}}]});
  if (r.method !== 'tools/call') throw new Error('Unexpected method');
  const a = r.params.arguments;
  if (a.action === 'create') sessions.set(a.session, a.sentinel);
  if (a.action === 'block') {
    executions++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 65000);
  }
  return send(r.id, {content:[{type:'text',text:JSON.stringify({exists:sessions.has(a.session),sentinel:sessions.get(a.session),executions})}]});
});
`);
  return {
    connection: { transport: 'stdio' as const, command: process.execPath, args: [script] },
    calls: () => readFileSync(wire, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

describe('MCP invocation deadlines with real ProcessRunner children', () => {
  it('completes 65 seconds of synchronous child work through installed/shared invocation, preserving idle session A', async () => {
    const f = fixture();
    const peer = sessionPeer(f.root, 'long');
    const contain = jest.spyOn(f.runner, 'closeAndTerminateDirectScope');
    try {
      f.manager.registerServer('one', peer.connection);
      await f.manager.startServer('one');
      const catalog = f.manager.getServerCatalog('one')!;
      const processId = f.manager.getServerStatus('one')!.processId;
      const call = async (args: Record<string, unknown>) => {
        const execution = await invokeToolForLlm(f.surface, 'mcp_tool_call', { serverName: 'one', bindingId: catalog.bindingId, catalogId: catalog.catalogId, toolName: 'session', args }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }));
        return settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome).providerResult;
      };
      expect(await call({ action: 'create', session: 'A', sentinel: 'idle-A-sentinel' })).toMatchObject({ success: true });
      expect(await call({ action: 'create', session: 'B', sentinel: 'busy-B-sentinel' })).toMatchObject({ success: true });
      const started = Date.now();
      const result = await call({ action: 'block', session: 'B' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(65_000);
      expect(result).toMatchObject({ success: true, content: [{ type: 'text', text: JSON.stringify({ exists: true, sentinel: 'busy-B-sentinel', executions: 1 }) }] });
      expect(await call({ action: 'read', session: 'A' })).toMatchObject({ success: true, content: [{ text: JSON.stringify({ exists: true, sentinel: 'idle-A-sentinel', executions: 1 }) }] });
      expect(peer.calls().filter(r => r.method === 'tools/call' && r.params.arguments.action === 'block')).toHaveLength(1);
      expect(peer.calls().filter(r => r.method === 'initialize')).toHaveLength(1);
      expect(f.manager.getServerCatalog('one')).toEqual(catalog);
      expect(f.manager.getServerStatus('one')).toMatchObject({ status: 'running', processId });
      expect(contain).not.toHaveBeenCalled();
    } finally { try { await f.close(); } finally { contain.mockRestore(); } }
  }, 115_000);

  it('internal short deadline terminates only that peer, loses its sessions on explicit fresh start and never replays', async () => {
    const f = fixture();
    const peer = sessionPeer(f.root, 'expiring');
    const independent = sessionPeer(f.root, 'independent');
    const contain = jest.spyOn(f.runner, 'closeAndTerminateDirectScope');
    try {
      for (const [name, p] of [['one', peer], ['C', independent]] as const) {
        f.manager.registerServer(name, p.connection);
        await f.manager.startServer(name);
      }
      const old = f.manager.getServerCatalog('one')!;
      const other = f.manager.getServerCatalog('C')!;
      const oldProcess = f.manager.getServerStatus('one')!.processId!;
      await f.manager.invokeTool('one', old.bindingId, old.catalogId, 'session', { action: 'create', session: 'A', sentinel: 'lost-on-stop' });
      await f.manager.invokeTool('one', old.bindingId, old.catalogId, 'session', { action: 'create', session: 'B', sentinel: 'busy' });
      await f.manager.invokeTool('C', other.bindingId, other.catalogId, 'session', { action: 'create', session: 'C', sentinel: 'independent-sentinel' });
      // Trusted internal option only: not public operator configuration.
      const error = await f.manager.invokeTool('one', old.bindingId, old.catalogId, 'session', { action: 'block', session: 'B' }, { timeoutMs: 1_000 }).catch(error => error);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('1000ms') });
      expect(contain).toHaveBeenCalledTimes(1);
      expect(f.manager.getServerCatalog('one')).toBeUndefined();
      expect(f.manager.getServerStatus('one')!.status).not.toBe('running');
      expect(f.runner.get(oldProcess)).toBeNull(); // Containment consumed and retired this launch.
      await expect(f.manager.invokeTool('one', old.bindingId, old.catalogId, 'session', { action: 'read', session: 'A' })).rejects.toThrow('not running');
      expect(peer.calls().filter(r => r.method === 'initialize')).toHaveLength(1);
      expect(peer.calls().filter(r => r.method === 'tools/call')).toHaveLength(3);
      expect(peer.calls().filter(r => r.method === 'tools/call' && r.params.arguments.action === 'block')).toHaveLength(1);
      expect(f.manager.getServerCatalog('C')).toEqual(other);
      await expect(f.manager.invokeTool('C', other.bindingId, other.catalogId, 'session', { action: 'read', session: 'C' })).resolves.toMatchObject({ content: [{ text: JSON.stringify({ exists: true, sentinel: 'independent-sentinel', executions: 0 }) }] });

      // A separately requested start, not automatic recovery of the failed call.
      await f.manager.startServer('one');
      const fresh = f.manager.getServerCatalog('one')!;
      expect(fresh.bindingId).not.toBe(old.bindingId);
      expect(fresh.catalogId).not.toBe(old.catalogId);
      expect(f.manager.getServerStatus('one')!.processId).not.toBe(oldProcess);
      await expect(f.manager.invokeTool('one', old.bindingId, old.catalogId, 'session', { action: 'read', session: 'A' })).rejects.toThrow('Stale MCP binding');
      expect(peer.calls().filter(r => r.method === 'tools/call')).toHaveLength(3);
      for (const session of ['A', 'B']) {
        await expect(f.manager.invokeTool('one', fresh.bindingId, fresh.catalogId, 'session', { action: 'read', session })).resolves.toMatchObject({ content: [{ text: JSON.stringify({ exists: false, executions: 0 }) }] });
      }
      expect(peer.calls().filter(r => r.method === 'initialize')).toHaveLength(2);
      expect(peer.calls().filter(r => r.method === 'tools/call' && r.params.arguments.action === 'block')).toHaveLength(1);
      expect(f.manager.getServerCatalog('C')).toEqual(other);
      await expect(f.manager.invokeTool('C', other.bindingId, other.catalogId, 'session', { action: 'read', session: 'C' })).resolves.toMatchObject({ content: [{ text: JSON.stringify({ exists: true, sentinel: 'independent-sentinel', executions: 0 }) }] });
    } finally { try { await f.close(); } finally { contain.mockRestore(); } }
  }, 20_000);
});
