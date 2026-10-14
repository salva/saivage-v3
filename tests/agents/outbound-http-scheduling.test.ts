import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { NO_FRESHNESS_EFFECTS, PublicationOutcomeUnknownError, type Candidate } from '../../src/contracts/index.js';
import { outboundIdentityReference, projectOutboundSource } from '../../src/observability/index.js';
import { chatSuccess, invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import { capturedHttp, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';
import { makeCodexJwt } from '../helpers/llm-test-helpers.js';

const primary = { provider: 'secret-provider', account: null, model: 'secret-model' };
const alternate = { provider: 'other', account: null, model: 'other-model' };
const inputId = '11111111-1111-4111-8111-111111111111';
const source = 'agent:planner:card-a';
const roots: string[] = [];
function request(chain: Candidate[] = [primary]): InvocationRequest {
  return { inputId, agentName: 'planner', sessionId: source, systemPrompt: 'secret-prompt',
    providerConversation: { sourceSessionId: source, messages: [] }, tools: [], terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: chain } };
}
function setup(chain = [primary], throwing = false) {
  const capture = capturedHttp(); const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/http-scheduling-'); roots.push(projectRoot);
  const service = new InvocationService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(chain),
    candidateAvailability: new MemoryCandidateAvailability(), outboundHttp: e => { capture.sink(e); if (throwing) throw new Error('sink'); } });
  return { service, ...capture };
}
function invoke(service: InvocationService, value: InvocationRequest, summary = false, signal?: AbortSignal) {
  const admission = service.preparePrimaryRequestAdmission(value);
  if (admission.kind !== 'admitted') throw new Error('Expected admission');
  return summary ? service.executeSummaryWithRecovery(admission, signal) : service.executeAdmittedWithRecovery(admission, signal);
}
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('actual invocation scheduler outbound observations', () => {
  it.each([false, true])('overload waits remain observable before logical completion (ordinary sink throws=%s)', async throwing => {
    jest.useFakeTimers({ now: 0 }); const { service, records } = setup([primary], throwing);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => fetch.mock.calls.length < 3
      ? new Response(JSON.stringify({ error: { code: 'overloaded', message: 'secret-wire' } }), { status: 503 }) : chatSuccess('done'));
    let settled = false; const pending = invoke(service, request()).then(r => { settled = true; return r; });
    for (const [index, delay] of [30000, 60000].entries()) {
      await jest.advanceTimersByTimeAsync(0); expect(settled).toBe(false); expect(fetch).toHaveBeenCalledTimes(index + 1);
      const wait = records.at(-1); expect(wait).toMatchObject({ event: 'outbound_http_retry_wait', retry_reason: 'overload', delay_ms: delay,
        attempt_index: index, request_id: records.filter(r => r.event === 'outbound_http_terminal').at(-1)!.request_id,
        waiting_candidate_ref: outboundIdentityReference(JSON.stringify(primary)) });
      await jest.advanceTimersByTimeAsync(delay - 1); expect(fetch).toHaveBeenCalledTimes(index + 1);
      await jest.advanceTimersByTimeAsync(1);
    }
    expect((await pending).result).toMatchObject({ content: 'done' }); assertLifecycles(records, 3);
    expect(records.filter(r => r.event === 'outbound_http_dispatch').map(r => r.attempt_index)).toEqual([0, 1, 2]);
    for (const record of records) {
      expect(record).toMatchObject(projectOutboundSource(source, inputId));
      if (record.event !== 'outbound_http_retry_wait') expect(record).toHaveProperty('model_ref', outboundIdentityReference(primary.model));
    }
    assertPrivateMetadata(records, ['secret-provider', 'secret-model', 'secret-prompt', 'secret-wire']); expect(jest.getTimerCount()).toBe(0);
  });
  it('routes immediately without claiming a wait and globally indexes actual dispatches', async () => {
    const { service, records } = setup([primary, alternate]);
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(chatSuccess('alternate'));
    expect((await invoke(service, request([primary, alternate]))).result).toMatchObject({ content: 'alternate' });
    assertLifecycles(records, 2); expect(records.filter(r => r.event === 'outbound_http_dispatch').map(r => r.attempt_index)).toEqual([0, 1]);
    expect(records.some(r => r.event === 'outbound_http_retry_wait')).toBe(false);
  });
  it('shared availability wait is visible without fabricating a preceding request', async () => {
    jest.useFakeTimers({ now: 0 }); const { records, sink } = setup(); const availability = new MemoryCandidateAvailability();
    availability.markFailed(primary, { state: 'COOLING', reason: 'server_transient', untilMs: 60000 });
    const svc = new InvocationService({ projectRoot: roots.at(-1)!, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([primary]), candidateAvailability: availability, outboundHttp: sink });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => chatSuccess('done'));
    const pending = invoke(svc, request()); await jest.advanceTimersByTimeAsync(0);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ event: 'outbound_http_retry_wait', retry_reason: 'availability', delay_ms: 60000 });
    expect(records[0]).not.toHaveProperty('request_id'); expect(fetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(59999); expect(fetch).not.toHaveBeenCalled(); await jest.advanceTimersByTimeAsync(1);
    expect((await pending).result).toMatchObject({ content: 'done' }); assertLifecycles(records, 1);
  });
  it.each([429, 503])('HTTP %s finite recovery reports the actual wait and four attempts', async status => {
    jest.useFakeTimers({ now: 0 }); const { service, records } = setup();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status, headers: { 'retry-after': '2' } }));
    const pending = invoke(service, request()).catch(e => e); await jest.advanceTimersByTimeAsync(0);
    expect(records.at(-1)).toMatchObject({ event: 'outbound_http_retry_wait', retry_reason: status === 429 ? 'rate_limit' : 'standard' });
    await jest.advanceTimersByTimeAsync(180000); expect(await pending).toMatchObject({ failure_phase: 'provider_attempt' });
    expect(fetch).toHaveBeenCalledTimes(4); assertLifecycles(records, 4);
    expect(records.filter(r => r.event === 'outbound_http_retry_wait')).toHaveLength(3); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([false, true])('cancels a sleeping retry through the explicit signal without a new dispatch (summary=%s)', async summary => {
    jest.useFakeTimers(); const { service, records } = setup(); const owner = new AbortController(); const reason = { exact: 'stop' };
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    const value = { ...request([primary]), ...(summary ? { sessionId: `internal:compaction-summary:${'a'.repeat(64)}` } : {}) };
    const pending = invoke(service, value, summary, owner.signal).catch(e => e); await jest.advanceTimersByTimeAsync(0);
    expect(records.at(-1)!.event).toBe('outbound_http_retry_wait'); owner.abort(reason); expect(await pending).toBe(reason);
    const count = records.length; await jest.advanceTimersByTimeAsync(600000); expect(records).toHaveLength(count); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pinned and internal summary keep actual indexes and original source, not synthetic owner', async () => {
    const { service, records } = setup(); jest.spyOn(globalThis, 'fetch').mockImplementation(async () => chatSuccess('done'));
    const pinned = service.preflightPinnedContentPolicyRequest({ ...request(), routePass: { kind: 'pinned-content-policy-retry', candidate: primary } });
    if (pinned.kind !== 'admitted') throw new Error('Expected pinned');
    await service.executePinnedContentPolicyRequest(pinned, { attemptIndex: 7 });
    const internal = `internal:compaction-summary:${'a'.repeat(64)}`;
    await invoke(service, { ...request(), sessionId: internal }, true);
    const dispatches = records.filter(r => r.event === 'outbound_http_dispatch');
    expect(dispatches[0]).toMatchObject({ attempt_index: 7, purpose: 'primary', ...projectOutboundSource(source, inputId) });
    expect(dispatches[1]).toMatchObject({ attempt_index: 0, purpose: 'internal-summary', invocation_session: internal, ...projectOutboundSource(source, inputId) });
    assertLifecycles(records, 2);
  });
  it('internal summary finite retry stays fixed-candidate and retains original source on wait and both dispatches', async () => {
    jest.useFakeTimers({ now: 0 }); const { service, records } = setup();
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 })).mockImplementation(async () => chatSuccess('summary'));
    const internal = `internal:compaction-summary:${'b'.repeat(64)}`;
    const pending = invoke(service, { ...request(), sessionId: internal }, true);
    await jest.advanceTimersByTimeAsync(0);
    expect(records.at(-1)).toMatchObject({ event: 'outbound_http_retry_wait', purpose: 'internal-summary', ...projectOutboundSource(source, inputId), invocation_session: internal, attempt_index: 0 });
    expect(fetch).toHaveBeenCalledTimes(1); await jest.advanceTimersByTimeAsync(60000);
    expect((await pending).result).toMatchObject({ content: 'summary' }); assertLifecycles(records, 2);
    expect(records.filter(r => r.event === 'outbound_http_dispatch').map(r => r.attempt_index)).toEqual([0, 1]);
    for (const record of records) expect(record).toMatchObject({ purpose: 'internal-summary', ...projectOutboundSource(source, inputId), invocation_session: internal });
  });
  it.each([
    { type: 'error', error: { code: 'server_is_overloaded', message: 'secret-sse-error' } },
    'malformed-secret-sse',
    { type: 'response.output_text.delta', delta: 'truncated-secret-sse' },
  ])('Codex HTTP-200 SSE failure/malformed/truncated is never successful HTTP handling: %p', async event => {
    jest.useFakeTimers();
    const codex = { provider: 'openai-codex', account: null, model: 'gpt-5' }; const capture = capturedHttp(); const root = mkdtempSync('/home/salva/g/ml/tmp/http-sse-'); roots.push(root);
    const service = new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, outboundHttp: capture.sink,
      candidateAvailability: new MemoryCandidateAvailability(), registry: invocationProviderRegistry([codex], { 'openai-codex': { transportProtocol: 'openai-codex-backend', exclusiveToolChoiceSupport: 'parallel_off' } }, { 'openai-codex': makeCodexJwt('test') }) });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`, { status: 200 }));
    const preflight = service.preflightPinnedContentPolicyRequest({ ...request([codex]), routePass: { kind: 'pinned-content-policy-retry', candidate: codex } });
    if (preflight.kind !== 'admitted') throw new Error('Expected admission');
    const owner = new AbortController();
    const pending = service.executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 }, owner.signal).catch(e => e);
    await jest.advanceTimersByTimeAsync(0);
    expect(capture.records.filter(r => r.event === 'outbound_http_terminal').at(-1)).toMatchObject({ status: 200, outcome: 'failed' });
    owner.abort(new Error('test stop')); expect(await pending).toBeDefined(); assertLifecycles(capture.records, 1);
    assertPrivateMetadata(capture.records, ['secret-sse-error', 'malformed-secret-sse', 'truncated-secret-sse']);
  });
  it('publication-unknown sink stops before retry, availability mutation or provider dispatch', async () => {
    jest.useFakeTimers();
    setup(); const fatal = new PublicationOutcomeUnknownError();
    const availability = new MemoryCandidateAvailability(); const changed = jest.spyOn(availability, 'markFailed');
    const svc = new InvocationService({ projectRoot: roots.at(-1)!, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([primary]), candidateAvailability: availability, outboundHttp: () => { throw fatal; } });
    const fetch = jest.spyOn(globalThis, 'fetch'); await expect(invoke(svc, request())).rejects.toBe(fatal); expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
});
