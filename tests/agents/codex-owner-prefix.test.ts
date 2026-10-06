import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { NO_FRESHNESS_EFFECTS, type ContextBlock, type ToolDefinition } from '../../src/contracts/index.js';
import { agentMessageSchema, canonicalJson, DURABLE_PRIMARY_CONTENT_POLICY, sha256Hex, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { composeContextProjection, providerConversationFromComposedContext, type EffectiveCompactedHistoryFacts } from '../../src/runtime/actors/context/composition-projector.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import { makeCodexJwt } from '../helpers/llm-test-helpers.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { buildAnalystOrientationSnapshot } from '../../src/application/read-models/analyst-orientation.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { RESPONSES_A, RESPONSES_B, responsesBundle } from '../helpers/responses-producer-fixture.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';

afterEach(() => { jest.restoreAllMocks(); });

const ROOT = '/synthetic/project-one';
const SESSION: ConversationSessionId = 'agent:executor:card-a';
const CANDIDATE = { provider: 'openai-codex', account: null, model: 'gpt-5' };
const SYSTEM = 'EXACT EXECUTOR INSTRUCTIONS';
const TOOLS: ToolDefinition[] = ['run_command', 'wait_process'].map(name => ({ type: 'function', function: { name, description: `Execute ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false } } }));
const BLOCK = Object.freeze({ id: 'node-activation:card-a:work', role: 'system', content: 'EXACT PREPARED WORK NODE', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } } satisfies ContextBlock);
const INPUTS = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000000${n}`);
const affinity = (root = ROOT, session = SESSION as string) => sha256Hex(JSON.stringify(['saivage-provider-session', root, session]));

function service(root = ROOT, window = 100_000) {
  return new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: new MemoryCandidateAvailability(), registry: invocationProviderRegistry([CANDIDATE], { 'openai-codex': { transportProtocol: 'openai-codex-backend', exclusiveToolChoiceSupport: 'parallel_off', contextWindowTokens: window } }, { 'openai-codex': makeCodexJwt('synthetic-account') }) });
}

function row(id: string, role: AgentMessage['role'], kind: AgentMessage['kind'], content: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: SESSION, role, kind, content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-10-06T00:00:00.000Z', ...extra });
}

function processPair(turn: number, status: 'running' | 'exited'): AgentMessage[] {
  const input = INPUTS[turn]!;
  const callId = `call-process-${turn}`;
  const tool = turn === 0 ? 'run_command' : 'wait_process';
  const args = turn === 0 ? '{"command":"synthetic-command"}' : '{"process_id":"proc-0123456789ab"}';
  const content = ` { "data": ${JSON.stringify({ process_id: 'proc-0123456789ab', status, exit_code: status === 'running' ? null : 0, stdout: `output-${turn}`, stderr: 'partial-warning', stdout_complete: true, stderr_complete: false, stdout_bytes: 8, stderr_bytes: 15, stdout_url: 'work:///processes/proc-0123456789ab/stdout.log', stderr_url: 'work:///processes/proc-0123456789ab/stderr.log' })}, "success": true } `;
  const policies = toolRowPolicies({ content, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
  return [
    row(`${input}:tool-call:${callId}`, 'assistant', 'tool_call', JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: args } }] }), { tool, tool_call_id: callId, context_policy: policies.call }),
    row(`${input}:tool-result:${callId}`, 'tool', 'tool_result', content, { tool, tool_call_id: callId, context_policy: policies.result }),
  ];
}

function request(rows: readonly AgentMessage[], turn = 0, blocks: readonly ContextBlock[] = [BLOCK], history: EffectiveCompactedHistoryFacts | null = null): InvocationRequest {
  return { inputId: INPUTS[turn]!, agentName: 'executor', sessionId: SESSION, systemPrompt: SYSTEM, providerConversation: providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: SESSION, effectiveHistory: history, dynamicBlocks: blocks, uncoveredRows: rows })), tools: TOOLS, terminalToolNames: [], modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true }, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] } };
}

function admitted(svc: InvocationService, invocation: InvocationRequest) {
  const admission = svc.preparePrimaryRequestAdmission(invocation);
  if (admission.kind !== 'admitted' || admission.candidates[0]?.kind !== 'admitted') throw new Error('Synthetic fixture must be admitted.');
  return { admission, built: admission.candidates[0].plan.request };
}

function success(): Response {
  return new Response('data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"continue"}]}}\n\ndata: {"type":"response.completed","response":{"id":"synthetic-response"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function scriptedFetch() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => success());
}

describe('actual composed Codex ordinary-turn requests', () => {
  it('keeps owner affinity independent of model/account routing and omits mixed-producer private bytes and request metadata', async () => {
    const registry = new ProviderRegistry({ ...structuredClone(DEFAULT_SAIVAGE_CONFIG), providers: { 'openai-codex': { models: ['gpt-5', 'other-model'], baseUrl: 'https://codex.example.test', accounts: { a: { apiKey: makeCodexJwt('synthetic-a') }, b: { apiKey: makeCodexJwt('synthetic-b') } }, capabilities: { transportProtocol: 'openai-codex-backend', toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off', contextWindowTokens: 100_000, maxOutputTokens: 10_000 } } } });
    const svc = new InvocationService({ projectRoot: ROOT, registry, freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: new MemoryCandidateAvailability() });
    const rows = [
      ...responsesBundle(SESSION, INPUTS[0]!, RESPONSES_A, '{"success":true,"data":"first exact output"}'),
      ...responsesBundle(SESSION, INPUTS[1]!, RESPONSES_B, '{"success":true,"data":"second exact output"}'),
    ];
    const original = canonicalJson(rows);
    const fetch = scriptedFetch();
    for (const [index, candidate] of [
      { ...CANDIDATE, account: 'a' },
      { ...CANDIDATE, account: 'a', model: 'other-model' },
      { ...CANDIDATE, account: 'b', model: 'other-model' },
    ].entries()) {
      const { admission, built } = admitted(svc, { ...request(rows, 2), routePass: { kind: 'ordinary', candidateChain: [candidate] } });
      expect(admission.execution.options.providerSessionId).toBe(affinity());
      const completion = await svc.executeAdmittedWithRecovery(admission);
      const init = fetch.mock.calls[index]![1]!;
      const headers = new Headers(init.headers);
      expect(init.body).toBe(built.serializedBody);
      expect(built.body).toMatchObject({ model: candidate.model, prompt_cache_key: affinity() });
      expect(headers.get('session-id')).toBe(affinity());
      expect(headers.get('chatgpt-account-id')).toBe(candidate.account === 'a' ? 'synthetic-a' : 'synthetic-b');
      expect(headers.get('authorization')).toBe(`Bearer ${makeCodexJwt(candidate.account === 'a' ? 'synthetic-a' : 'synthetic-b')}`);
      expect(built.serializedBody).not.toContain(ROOT);
      expect(built.serializedBody).not.toContain('ciphertext-');
      expect(built.serializedBody).not.toContain('producer_account_id');
      expect(built.serializedBody).toContain('first exact output');
      expect(built.serializedBody).toContain('second exact output');
      expect(completion.provider_exchanges[0]).toMatchObject({ model: candidate.model, account: candidate.account });
      expect(completion.provider_private_context).toBeUndefined();
      const metadata = canonicalJson(completion.provider_exchanges);
      for (const privateValue of [ROOT, SYSTEM, BLOCK.content, affinity(), makeCodexJwt('synthetic-a'), makeCodexJwt('synthetic-b'), responsesProducerAccountId(RESPONSES_A), responsesProducerAccountId(RESPONSES_B)]) expect(metadata).not.toContain(privateValue);
      expect(completion.provider_exchanges[0]!.request_params).toEqual({ endpoint: 'https://codex.example.test/codex/responses', method: 'POST', stream: true, offered_tools_count: 2 });
    }
    expect(canonicalJson(rows)).toBe(original);
  });
  it('preserves completed and running/partial outputs through three turns with exact fixed instructions and tools', async () => {
    const fetch = scriptedFetch();
    const svc = service();
    const rows = [row('requirement', 'user', 'text', 'EXACT RETAINED REQUIREMENT'), ...processPair(0, 'exited')];
    const original = structuredClone(rows);
    const bodies: Record<string, unknown>[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const { admission, built } = admitted(svc, request(rows, turn));
      const completion = await svc.executeAdmittedWithRecovery(admission);
      expect(completion.result).toEqual({ kind: 'message', content: 'continue' });
      const init = fetch.mock.calls[turn]![1]!;
      expect(init.body).toBe(built.serializedBody);
      expect(sha256Hex(String(init.body))).toBe(built.requestHash);
      expect(built.estimatedWireInputTokens).toBe(Math.ceil(Buffer.byteLength(String(init.body), 'utf8') / 4));
      expect(completion.provider_exchanges[0]!.request_params).toEqual({ endpoint: 'https://openai-codex.example.test/codex/responses', method: 'POST', stream: true, offered_tools_count: 2 });
      bodies.push(JSON.parse(String(init.body)));
      if (turn < 2) rows.push(...processPair(turn + 1, turn === 0 ? 'running' : 'exited'));
    }
    expect(rows.slice(0, original.length)).toEqual(original);
    for (const body of bodies) {
      expect(body.instructions).toBe(SYSTEM);
      expect(body.tools).toEqual(TOOLS.map(({ function: fn }) => ({ type: 'function', ...fn })));
      expect(body.tool_choice).toBe('auto');
      expect(body.parallel_tool_calls).toBe(false);
    }
    const inputs = bodies.map(body => body.input as Record<string, unknown>[]);
    for (let turn = 1; turn < 3; turn++) {
      expect(inputs[turn]).toHaveLength(inputs[turn - 1]!.length + 2);
      expect(canonicalJson(inputs[turn]!.slice(0, inputs[turn - 1]!.length))).toBe(canonicalJson(inputs[turn - 1]));
    }
    for (let turn = 0; turn < 3; turn++) {
      const call = inputs[2]!.find(item => item.type === 'function_call' && item.call_id === `call-process-${turn}`)!;
      expect(call).toEqual({ type: 'function_call', call_id: `call-process-${turn}`, name: turn === 0 ? 'run_command' : 'wait_process', arguments: turn === 0 ? '{"command":"synthetic-command"}' : '{"process_id":"proc-0123456789ab"}' });
      const output = inputs[2]!.find(item => item.type === 'function_call_output' && item.call_id === call.call_id)!;
      const source = JSON.parse(rows.find(item => item.kind === 'tool_result' && item.tool_call_id === call.call_id)!.content);
      if (turn !== 1) delete source.data.stdout_url;
      expect(output).toEqual({ type: 'function_call_output', call_id: call.call_id, output: canonicalJson(source) });
      expect(JSON.parse(String(output.output)).data.stderr_url).toBe('work:///processes/proc-0123456789ab/stderr.log');
    }
    expect(inputs[0]![0]).toEqual({ role: 'system', content: BLOCK.content });
    expect(inputs[0]).toContainEqual({ role: 'user', content: [{ type: 'input_text', text: 'EXACT RETAINED REQUIREMENT' }] });
  });

  it('sends the same owner affinity in the admitted body and session-id header across fresh input UUIDs', async () => {
    const fetch = scriptedFetch();
    const svc = service();
    const rows = [row('requirement', 'user', 'text', 'task'), ...processPair(0, 'exited')];
    const identities: unknown[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const { admission, built } = admitted(svc, request(rows, turn));
      await svc.executeAdmittedWithRecovery(admission);
      identities.push({ body: built.body.prompt_cache_key, header: new Headers(fetch.mock.calls[turn]![1]!.headers).get('session-id') });
      if (turn < 2) rows.push(...processPair(turn + 1, turn === 0 ? 'running' : 'exited'));
    }
    expect(identities).toEqual(Array.from({ length: 3 }, () => ({ body: affinity(), header: affinity() })));
  });

  it('retains new activation context and compacted summary/protected tail instead of preserving obsolete prefixes', () => {
    const svc = service();
    const old = row('old-work', 'user', 'text', 'OLD COVERED WORK');
    const protectedRow = row('protected', 'user', 'text', 'EXACT PROTECTED REQUIREMENT', { context_policy: { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: false } });
    const tail = row('tail', 'user', 'text', 'EXACT CURRENT TAIL');
    const first = admitted(svc, request([old, protectedRow, tail])).built.body;
    const changedBlock = { ...BLOCK, id: 'node-activation:card-a:verify', content: 'NEW VERIFY NODE' };
    const changed = admitted(svc, request([old, protectedRow, tail], 1, [changedBlock])).built.body;
    expect(changed.input).not.toEqual(first.input);
    expect((changed.input as unknown[])[0]).toEqual({ role: 'system', content: 'NEW VERIFY NODE' });
    const compacted = admitted(svc, request([tail], 2, [changedBlock], { historyMessageId: 'genesis:history', historyTimestamp: '2026-10-06T00:00:00.000Z', summaryText: 'SELECTED SUMMARY', protectedPrompts: [{ source: { segmentVersion: 1, rowIndex: 1 }, message: protectedRow }], requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } })).built.body;
    expect(JSON.stringify(compacted.input)).not.toContain('OLD COVERED WORK');
    expect(compacted.input).toEqual(expect.arrayContaining([
      { role: 'system', content: 'Historical summary:\nSELECTED SUMMARY' },
      { role: 'user', content: [{ type: 'input_text', text: 'EXACT PROTECTED REQUIREMENT' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'EXACT CURRENT TAIL' }] },
    ]));
  });

  it('separates project and invocation owners while surviving reconstruction, activation and compaction', () => {
    const invocation = request([]);
    const key = (root: string, sessionId: string, value = invocation) => admitted(service(root), { ...value, sessionId }).built.body.prompt_cache_key;
    expect(key(ROOT, SESSION)).toBe(affinity());
    expect(key(ROOT, SESSION, { ...invocation, inputId: INPUTS[1]! })).toBe(affinity());
    expect(key(ROOT, SESSION, request([], 2, [{ ...BLOCK, content: 'NEW ACTIVATION' }], { historyMessageId: 'history', historyTimestamp: '2026-10-06T00:00:00.000Z', summaryText: 'compacted source', protectedPrompts: [], requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null } }))).toBe(affinity());
    for (const [root, session] of [[ROOT + '-two', SESSION], [ROOT, 'agent:executor:card-b'], [ROOT, 'agent:reviewer:card-a'], [ROOT, `internal:compaction-summary:${sha256Hex(SESSION)}`]]) {
      expect(key(root!, session!)).toBe(affinity(root!, session!));
      expect(key(root!, session!)).not.toBe(affinity());
    }
  });

  it('uses a newly prepared Analyst orientation rather than retaining the old observation for prefix reuse', () => {
    const analyst: ConversationSessionId = 'agent:analyst:global';
    const orientation = (version: number, title: string): ContextBlock => {
      const snapshot = buildAnalystOrientationSnapshot([{ id: 'project', parent: null, type: 'project', status: 'backlog', title, version_seq: version, children: [] }], { status: 'stopped', currentCardId: null });
      return { ...BLOCK, id: `analyst-submission:${version}`, content: snapshot.content, replacement: { kind: 'latest_snapshot', key: 'analyst.project_tree', contentSha256: snapshot.contentSha256 } };
    };
    const old = orientation(1, 'Old project observation');
    const latest = orientation(2, 'New project observation');
    const invocation = (blocks: ContextBlock[]): InvocationRequest => ({ ...request([]), agentName: 'analyst', sessionId: analyst, providerConversation: providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: analyst, effectiveHistory: null, dynamicBlocks: blocks, uncoveredRows: [] })) });
    const svc = service();
    const first = admitted(svc, invocation([old])).built.body;
    const second = admitted(svc, invocation([old, latest])).built.body;
    expect(second.input).not.toEqual(first.input);
    expect(second.input).toEqual([{ role: 'system', content: latest.content }]);
    expect(JSON.stringify(second.input)).not.toContain('Old project observation');
    expect(second.instructions).toBe(first.instructions);
  });

  it('rejects a complete new request above exact capacity before fetch', () => {
    const fetch = scriptedFetch();
    const invocation = request([]);
    const built = admitted(service(), invocation).built;
    expect(built.body.prompt_cache_key).toBe(affinity());
    const withoutKey = { ...built.body };
    delete withoutKey.prompt_cache_key;
    const oldEstimate = Math.ceil(Buffer.byteLength(canonicalJson(withoutKey), 'utf8') / 4);
    expect(built.estimatedWireInputTokens).toBeGreaterThan(oldEstimate);
    const window = oldEstimate + 2000;
    const rejected = service(ROOT, window).preparePrimaryRequestAdmission({ ...invocation, preparedCompaction: undefined, preparedContext: undefined, modelParams: { temperature: 0, maxTokens: 2000 }, contextUtilizationFraction: 1 });
    expect(rejected.kind).toBe('local_compaction_required');
    expect(rejected.candidates[0]).toMatchObject({ kind: 'projection_too_large', estimatedInputTokens: built.estimatedWireInputTokens, usableInputTokens: oldEstimate });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['openai-chat-completions', 'openai-responses'] as const)('keeps %s wire contract free of Codex affinity', (protocol) => {
    const { admission } = admitted(service(), request([]));
    const options = admission.execution.options;
    const invocation = request([]);
    const adapter = selectLlmProtocolAdapter(protocol);
    const capabilities = { transportProtocol: protocol, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, quirks: [] };
    const body = adapter.buildRequestBody({ candidate: CANDIDATE, systemPrompt: SYSTEM, providerConversation: invocation.providerConversation, options, capabilities });
    const wire = adapter.deriveWire(CANDIDATE, { baseUrl: 'https://example.test', apiKey: 'synthetic-key' }, body, options);
    const otherOptions = { ...options, providerSessionId: 'different-owner-affinity' };
    const otherBody = adapter.buildRequestBody({ candidate: CANDIDATE, systemPrompt: SYSTEM, providerConversation: invocation.providerConversation, options: otherOptions, capabilities });
    expect(canonicalJson(otherBody)).toBe(canonicalJson(body));
    expect(adapter.deriveWire(CANDIDATE, { baseUrl: 'https://example.test', apiKey: 'synthetic-key' }, otherBody, otherOptions)).toEqual(wire);
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(new Headers(wire.headers).has('session-id')).toBe(false);
    expect(canonicalJson(body)).not.toContain(affinity());
  });

  it('derives Codex header from the built body and rejects absent, non-string and empty body affinity at use', () => {
    const { admission, built } = admitted(service(), request([]));
    const options = admission.execution.options;
    const adapter = selectLlmProtocolAdapter('openai-codex-backend');
    const transport = { baseUrl: 'https://example.test', apiKey: makeCodexJwt('synthetic-account'), openAICodexAccountId: 'synthetic-account' };
    const bodyOwnedKey = 'b'.repeat(64);
    const wire = adapter.deriveWire(CANDIDATE, transport, { ...built.body, prompt_cache_key: bodyOwnedKey }, options);
    expect(new Headers(wire.headers).get('session-id')).toBe(bodyOwnedKey);
    for (const invalid of [undefined, 42, '']) {
      expect(() => adapter.deriveWire(CANDIDATE, transport, { ...built.body, prompt_cache_key: invalid }, options)).toThrow();
    }
  });
});
