import { afterEach, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import type { normalizeImage as Normalize } from '../../src/tools/image-decode.js';
import { conversationImageFile } from '../../src/persistence/layout.js';
const normalize = jest.fn<typeof Normalize>();
jest.unstable_mockModule('../../src/tools/image-decode.js', () => ({ normalizeImage: normalize, normalizeWorkspaceImage: jest.fn() }));
const { mcpToolBinders } = await import('../../src/tools/mcp-provider.js');
const { testLlmToolInvocationContext, unusedMcpToolInvocation } = await import('../helpers/llm-test-helpers.js');
const { ImageInputError } = await import('../../src/tools/image-input-error.js');
const { PublicationOutcomeUnknownError } = await import('../../src/contracts/index.js');
const { McpServerRuntime } = await import('../../src/mcp/server-runtime.js');
const { McpInvocationStatsRecorder } = await import('../../src/mcp/invocation-stats.js');
const roots: string[] = [];
afterEach(() => { normalize.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each([false, true])(
  'internal connection closure alone permits native publication; original caller cancellation=%s still fences normalization',
  async (cancel) => {
    const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/mcp-native-lifetime-');
    roots.push(projectRoot);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let id = 0;
    let finishTerminal!: (value: any) => void;
    const terminal = new Promise<any>((resolve) => {
      finishTerminal = resolve;
    });
    const runtime = new McpServerRuntime({
      name: 'one',
      config: { transport: 'stdio', command: 'synthetic', autostart: false, disabled: false },
      revision: 'r',
      processScope: {} as never,
      projectRoot,
      processRunner: {
        spawnInteractive: () => ({ process: { stdin, stdout, stderr }, record: { id: 'p' } }),
        get: () => ({ status: 'running' }),
        waitForSettlement: () => terminal,
        retireSettled() {},
        closeAndTerminateDirectScope: async () => {
          await terminal;
          return { failed: [] };
        },
      } as never,
      ids: { next: () => ++id },
      invocationStats: new McpInvocationStatsRecorder({ appendEventPrepared() {} } as never),
    });
    stdin.on('data', (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.method === 'notifications/initialized') return;
      const result =
        request.method === 'initialize'
          ? {}
          : request.method === 'tools/list'
            ? { tools: [{ name: 'screen', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] };
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      if (request.method === 'tools/call') stdout.emit('end');
    });
    let entered!: () => void;
    let finish!: (value: Awaited<ReturnType<typeof Normalize>>) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    normalize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    const controller = new AbortController();
    const reason = { exact: 'original native caller' };
    try {
      await runtime.start();
      const tool = mcpToolBinders
        .find((binder) => binder.name === 'mcp_tool_call')!
        .bind({
          projectRoot,
          mcpToolInvocation: {
            ...unusedMcpToolInvocation,
            invokeTool: (_server, toolName, args, options) =>
              runtime.invokeTool(toolName, args, options),
            getServerTools: () => runtime.getTools(),
            findToolCapability: () => null,
          },
        });
      const operation = tool.executor(
        { serverName: 'one', toolName: 'screen' },
        controller.signal,
        testLlmToolInvocationContext({
          sessionId: 'agent:analyst:global',
          toolName: 'mcp_tool_call',
        }),
      );
      await started;
      expect(runtime.isReady()).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      if (cancel) controller.abort(reason);
      finish({
        bytes: Buffer.from('test-normalized'),
        data: {
          source_dimensions: { width: 1, height: 1 },
          oriented_dimensions: { width: 1, height: 1 },
          sent_dimensions: { width: 1, height: 1 },
          orientation_applied: false,
          resized: false,
          scale: { x: 1, y: 1 },
          max_dimension: 1600,
        },
      });
      if (cancel) await expect(operation).rejects.toBe(reason);
      else expect((await operation).providerOutcome.kind).toBe('succeeded');
      expect(
        existsSync(
          dirname(
            conversationImageFile(
              projectRoot,
              'agent:analyst:global',
              '11111111-1111-4111-8111-111111111111',
            ),
          ),
        ),
      ).toBe(!cancel);
    } finally {
      finishTerminal({ record: { status: 'exited', signal: null } });
      await runtime.stop();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  },
);
it.each(['agent:executor:project', 'agent:analyst:global'] as const)('fences exact %s publication after conversion succeeds or fails recognizably', async sessionId => {
  for (const failure of [false, true]) {
    const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/mcp-native-cancel-'); roots.push(projectRoot);
    let resolve!: (value: Awaited<ReturnType<typeof Normalize>>) => void;
    let reject!: (reason: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    normalize.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; entered(); }));
    const tool = mcpToolBinders.find(binder => binder.name === 'mcp_tool_call')!.bind({ projectRoot, mcpToolInvocation: { ...unusedMcpToolInvocation, invokeTool: async () => ({ content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] }), getServerTools: () => undefined, findToolCapability: () => null } });
    const controller = new AbortController(); const reason = { exact: 'conversion cancellation' };
    const operation = tool.executor({ serverName: 'one', toolName: 'screen' }, controller.signal, testLlmToolInvocationContext({ sessionId, toolName: 'mcp_tool_call' }));
    await started; controller.abort(reason);
    if (failure) reject(new ImageInputError('recognized conversion failure'));
    else resolve({ bytes: Buffer.from('must not publish'), data: { source_dimensions: { width: 1, height: 1 }, oriented_dimensions: { width: 1, height: 1 }, sent_dimensions: { width: 1, height: 1 }, orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600 } });
    await expect(operation).rejects.toBe(reason);
    expect(normalize).toHaveBeenLastCalledWith(Buffer.from('a'), 1600, 'image/png');
    expect(existsSync(dirname(conversationImageFile(projectRoot, sessionId, '11111111-1111-4111-8111-111111111111')))).toBe(false);
  }
});
it('checks aggregate sources after normalization but before any publication', async () => {
  const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/mcp-native-aggregate-'); roots.push(projectRoot);
  normalize.mockResolvedValue({ bytes: Buffer.from('unpublished'), data: { source_dimensions: { width: 1, height: 1 }, oriented_dimensions: { width: 1, height: 1 }, sent_dimensions: { width: 1, height: 1 }, orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600 } });
  const block = { type: 'image', data: Buffer.alloc(17 * 1024 * 1024).toString('base64'), mimeType: 'image/png' };
  const tool = mcpToolBinders.find(binder => binder.name === 'mcp_tool_call')!.bind({ projectRoot, mcpToolInvocation: { ...unusedMcpToolInvocation, invokeTool: async () => ({ content: [block, block] }), getServerTools: () => undefined, findToolCapability: () => null } });
  const execution = await tool.executor({ serverName: 'one', toolName: 'screen' }, new AbortController().signal, testLlmToolInvocationContext({ sessionId: 'agent:analyst:global', toolName: 'mcp_tool_call' }));
  expect(execution.providerOutcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('aggregate 32 MiB') });
  expect(normalize).toHaveBeenCalledTimes(1);
  expect(existsSync(dirname(conversationImageFile(projectRoot, 'agent:analyst:global', '11111111-1111-4111-8111-111111111111')))).toBe(false);
});
it('does not substitute later cancellation for unclassified conversion/publication failure', async () => {
  for (const failure of [new Error('unexpected decoder failure'), new PublicationOutcomeUnknownError()]) {
    const controller = new AbortController();
    normalize.mockImplementationOnce(async () => { controller.abort({ later: 'cancel' }); throw failure; });
    const tool = mcpToolBinders.find(binder => binder.name === 'mcp_tool_call')!.bind({ projectRoot: '/unused', mcpToolInvocation: { ...unusedMcpToolInvocation, invokeTool: async () => ({ content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] }), getServerTools: () => undefined, findToolCapability: () => null } });
    await expect(tool.executor({ serverName: 'one', toolName: 'screen' }, controller.signal, testLlmToolInvocationContext({ sessionId: 'agent:analyst:global', toolName: 'mcp_tool_call' }))).rejects.toBe(failure);
  }
});
