import { afterEach, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { normalizeImage as Normalize } from '../../src/tools/image-decode.js';
import { conversationImageFile } from '../../src/persistence/layout.js';
const normalize = jest.fn<typeof Normalize>();
jest.unstable_mockModule('../../src/tools/image-decode.js', () => ({ normalizeImage: normalize, normalizeWorkspaceImage: jest.fn() }));
const { mcpToolBinders } = await import('../../src/tools/mcp-provider.js');
const { testLlmToolInvocationContext, unusedMcpToolInvocation } = await import('../helpers/llm-test-helpers.js');
const { ImageInputError } = await import('../../src/tools/image-input-error.js');
const { PublicationOutcomeUnknownError } = await import('../../src/contracts/index.js');
const roots: string[] = [];
afterEach(() => { normalize.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
