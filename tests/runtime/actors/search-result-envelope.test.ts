import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService } from '../../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../../src/agents/candidate-availability.js';
import { createInvocationServiceProvider } from '../../../src/application/invocation-service-provider.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/application/freshness-effects.js';
import { canonicalJson } from '../../../src/schemas/index.js';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext, compileInvocationToolContract } from '../../../src/runtime/actors/context/context-blocks.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { workspaceToolBinders } from '../../../src/tools/workspace-provider.js';
import { invokeToolForLlm, llmToolDefinition } from '../../../src/tools/invocation.js';
import { bindToolProvider } from '../../helpers/bind-tool-provider.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { invocationProviderRegistry } from '../../helpers/invocation-provider-fixture.js';
import { buildInvocationSurfaceFixture } from '../../helpers/invocation-surface-fixture.js';

const CANDIDATE = { provider: 'fixture', account: null, model: 'fixture-model' } as const;
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('search result actor/provider envelope', () => {
  it.each(['glob', 'grep'] as const)('settles and sends a real bounded %s page through the provider transport', async (toolName) => {
    const root = mkdtempSync(join(tmpdir(), `saivage-actor-${toolName}-`));
    roots.push(root);
    initProjectTree(root);
    const contextual = `ask-secret-tail art_secret_tail atok_secret_tail aghu_secret_tail quoted-"-\\-🚀 token=synthetic-token-value api_key=synthetic-api-value`;
    if (toolName === 'glob') {
      const segments = Array.from({ length: 4 }, (_, index) => `${index}-${contextual}-${'x'.repeat(70)}`);
      mkdirSync(join(root, ...segments), { recursive: true });
      writeFileSync(join(root, ...segments, 'match.txt'), 'needle', 'utf8');
    } else {
      writeFileSync(join(root, 'match.txt'), `${contextual} ${'dense '.repeat(90)} needle`, 'utf8');
    }

    const provider = bindToolProvider('workspace', workspaceToolBinders, { projectRoot: root, cardId: 'project', agentName: 'planner', store: new CardService(root) });
    const surface = buildInvocationSurfaceFixture('planner', [provider]);
    const definition = surface.tools.get(toolName)!;
    const contract = compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate);
    const input = invocation(contract);
    const requests: Array<{ messages: Array<{ role: string; content: string; tool_call_id?: string }> }> = [];
    let requestNumber = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      requestNumber += 1;
      if (requestNumber === 1) {
        const args = toolName === 'glob'
          ? { directory: '.', pattern: '**/*.txt', response_bytes: 512, max_results: 1 }
          : { path: '.', pattern: 'needle', response_bytes: 512, max_results: 1 };
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'search-call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const service = new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([CANDIDATE], { fixture: { contextWindowTokens: 100_000, maxOutputTokens: 100_000 } }), candidateAvailability: new MemoryCandidateAvailability() });
    const actor = new ConversationLLMActor({ purpose: { kind: 'autonomous-card', cardId: 'project' }, gate: new RuntimeGate(), agentId: input.sessionId, provider: createInvocationServiceProvider(service), conversations: { projectRoot: root }, compactor: { shouldCompact: () => false, compact: async () => { throw new Error('unexpected compaction'); } }, summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: () => { throw new Error('unexpected summary'); }, completeTurn: async () => { throw new Error('unexpected summary'); }, projectProviderExchanges: () => undefined }, fatalPort: { publicationOutcomeUnknown(error): never { throw error; } } });
    const call = await actor.turn(input, undefined, () => undefined);
    if (call.type !== 'tool_call') throw new Error('Expected search tool call.');
    const args = JSON.parse(actor.waitingToolArguments(call));
    const legacyEquivalent = toolName === 'glob'
      ? { directory: '.', pattern: '**/*.txt', matches: [join(...Array.from({ length: 4 }, (_, index) => `${index}-${contextual}-${'x'.repeat(70)}`), 'match.txt')], truncated: false }
      : { pattern: 'needle', matches: [{ path: 'match.txt', line: 1, preview: `${contextual} ${'dense '.repeat(90)}`.slice(0, 500) }], truncated: false };
    expect(Buffer.byteLength(canonicalJson({ success: true, data: legacyEquivalent }), 'utf8')).toBeGreaterThan(512);

    const settlement = await invokeToolForLlm(surface, toolName, args, actor.toolInvocationContext(call));
    const continued = await actor.appendToolResult(call.toolCallId, settlement);
    expect(continued.outcome.type).toBe('result');
    expect(Buffer.byteLength(continued.settled.settledResultBytes, 'utf8')).toBeLessThanOrEqual(512);
    expect(requests).toHaveLength(2);
    const wire = requests[1]!.messages.find((message) => message.role === 'tool');
    expect(wire).toEqual({ role: 'tool', content: continued.settled.settledResultBytes, tool_call_id: 'search-call' });
    expect(JSON.parse(wire!.content)).toEqual(continued.settled.providerResult);
    expect(canonicalJson(JSON.parse(wire!.content))).toBe(continued.settled.settledResultBytes);
    const page = (continued.settled.providerResult.data as { matches: { items: Array<{ content_hex?: string }>; next: unknown } }).matches;
    expect(page.next).not.toBeNull();
    expect(page.items[0]!.content_hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
    expect(wire!.content).not.toContain('synthetic-token-value');
    expect(wire!.content).not.toContain('synthetic-api-value');
  });
});

function invocation(contract: ReturnType<typeof compileInvocationToolContract>): PreparedLlmInvocationInput {
  const sessionId = 'agent:planner:project' as const;
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' }, 'system', [], 80_000, 2_000);
  return {
    inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName: 'planner', sessionId, systemPrompt: 'system',
    providerConversation: { sourceSessionId: sessionId, messages: [] }, tools: [contract.providerDefinition], compiledToolContracts: [contract], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [contract], dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: { requiresTools: true }, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {},
  };
}
