import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { projectOutboundSource } from '../../src/observability/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { capturedHttp, deferred, microtasks, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';
import { controlledResponse, pendingHeaders } from '../helpers/provider-inactivity.js';

// No DNS or HTTP leaves this process, including DuckDuckGo admission.
jest.unstable_mockModule('node:dns/promises', () => ({ lookup: async (host: string) => [{ address: host === '127.0.0.1' ? host : '93.184.216.34', family: 4 }] }));
const { webToolBinders } = await import('../../src/tools/web-tools.js');
const { invokeTestTool } = await import('../helpers/invoke-test-tool.js');
const { testLlmToolInvocationContext } = await import('../helpers/llm-test-helpers.js');
const { CardService, initProjectTree, testAnalystMutationServices } = await import('../helpers/canonical-project.js');
const roots: string[] = [];
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync('/home/salva/g/ml/tmp/web-http-'); roots.push(root); const capture = capturedHttp();
  const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('web', webToolBinders, { projectRoot: root, agentName: 'executor', outboundHttp: capture.sink })]);
  return { root, surface, ...capture };
}
describe('web binder outbound source and response policy', () => {
  it('concurrent webfetch/websearch keep caller identity across deferred headers/body and manual redirect hops', async () => {
    const f = fixture(); const headers = [deferred<Response>(), deferred<Response>()]; const calls: RequestInit[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => { calls.push(init!); return headers[calls.length - 1]!.promise; });
    const owners = ['card-a', 'card-b'].map((card, i) => testLlmToolInvocationContext({ sessionId: `agent:executor:${card}`, sourceInputId: `${i + 1}${'1'.repeat(7)}-1111-4111-8111-111111111111`, toolName: i === 0 ? 'webfetch' : 'websearch' }));
    const first = invokeTestTool(f.surface, 'webfetch', { url: 'https://secret-host.invalid/secret-path?secret-query#secret-fragment', read_mode: 'text' }, undefined, owners[0]);
    const second = invokeTestTool(f.surface, 'websearch', { query: 'secret-search-query', max_results: 1 }, undefined, owners[1]);
    await microtasks(); expect(fetch).toHaveBeenCalledTimes(2); expect(f.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_dispatch']);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    headers[1]!.resolve(new Response(new ReadableStream({ start(c) { body = c; } }), { headers: { 'content-type': 'text/html', 'set-cookie': 'secret-cookie' } }));
    await microtasks(); expect(f.records.filter(r => r.event === 'outbound_http_headers')).toHaveLength(1); expect(f.records.some(r => r.event === 'outbound_http_terminal')).toBe(false);
    fetch.mockImplementationOnce(async (_url, init) => { calls.push(init!); return new Response('secret-web-result', { headers: { 'content-type': 'text/plain' } }); });
    headers[0]!.resolve(new Response('secret-redirect-body', { status: 302, headers: { location: 'https://redirect-secret.invalid/secret-next?secret-redirect-query#secret-next-fragment' } }));
    expect(await first).toMatchObject({ success: true });
    body.enqueue(new TextEncoder().encode('<a class="result__a" href="https://example.invalid">secret-search-result</a>')); body.close();
    expect(await second).toMatchObject({ success: true }); assertLifecycles(f.records, 3);
    const dispatches = f.records.filter(r => r.event === 'outbound_http_dispatch');
    for (const dispatch of dispatches) {
      const owner = dispatch.purpose === 'websearch' ? owners[1]! : owners[0]!;
      for (const phase of f.records.filter(r => 'request_id' in r && r.request_id === dispatch.request_id)) expect(phase).toMatchObject(projectOutboundSource(owner.sessionId, owner.sourceInputId));
    }
    const redirectEnd = f.records.findIndex(r => r.event === 'outbound_http_terminal' && r.status === 302);
    expect(f.records[redirectEnd + 1]!.event).toBe('outbound_http_dispatch');
    for (const call of calls) expect(call.redirect).toBe('manual');
    assertPrivateMetadata(f.records, ['secret-host', 'secret-path', 'secret-query', 'secret-fragment', 'secret-search-query', 'secret-search-result', 'secret-cookie', 'secret-web-result', 'secret-redirect-body', 'redirect-secret', 'secret-next', 'secret-redirect-query']);
  });
  it.each(['metadata', 'bounded', 'empty', 'http-error', 'body-limit'] as const)('reports honest %s handling without invented EOF', async mode => {
    const f = fixture(); const cancel = jest.fn(() => undefined);
    const response = mode === 'empty' ? new Response(null) : new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('secret-large-body')); c.close(); }, cancel }), { status: mode === 'http-error' || mode === 'body-limit' ? 503 : 200, headers: { 'content-type': 'text/plain' } });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const owner = testLlmToolInvocationContext({ sessionId: 'agent:executor:card-a', sourceInputId: '11111111-1111-4111-8111-111111111111', toolName: 'webfetch' });
    const result = await invokeTestTool(f.surface, 'webfetch', { url: 'https://93.184.216.34', ...(mode === 'metadata' ? { metadata_only: true } : {}), ...(mode === 'bounded' || mode === 'body-limit' ? { max_bytes: 3, max_inline_bytes: 3 } : {}) }, undefined, owner);
    expect(result.success).toBe(mode !== 'body-limit' && mode !== 'http-error');
    expect(f.records.at(-1)).toMatchObject({ ...projectOutboundSource(owner.sessionId, owner.sourceInputId), outcome: mode === 'body-limit' ? 'failed' : mode === 'http-error' ? 'http_error' : 'completed', body_disposition: mode === 'metadata' || mode === 'bounded' ? 'cancelled_by_policy' : mode === 'empty' ? 'not_consumed' : mode === 'body-limit' ? 'incomplete' : 'consumed' });
    assertLifecycles(f.records, 1); assertPrivateMetadata(f.records, ['secret-large-body']);
  });
  it('denied private targets and URL credentials have no dispatch or network effect', async () => {
    const f = fixture(); const fetch = jest.spyOn(globalThis, 'fetch');
    for (const url of ['https://127.0.0.1/private-secret', 'https://secret-user:secret-pass@93.184.216.34/']) expect(await invokeTestTool(f.surface, 'webfetch', { url })).toMatchObject({ success: false });
    expect(fetch).not.toHaveBeenCalled(); expect(f.records).toEqual([]);
  });
  it.each(['cancel-headers', 'cancel-body', 'timeout'] as const)('deferred %s emits normalized terminal and preabort starts nothing', async mode => {
    jest.useFakeTimers(); const f = fixture(); const owner = new AbortController(); const deadline = new AbortController();
    const reason = new Error('secret-owner-reason');
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => mode === 'cancel-body' ? Promise.resolve(controlledResponse(init!.signal!).response) : pendingHeaders(init!.signal!));
    const pending = invokeTestTool(f.surface, 'webfetch', { url: 'https://93.184.216.34' }, owner.signal).catch(e => e);
    await microtasks(); expect(f.records.filter(r => r.event === 'outbound_http_dispatch')).toHaveLength(1);
    expect(f.records.some(r => r.event === 'outbound_http_terminal')).toBe(false);
    if (mode === 'timeout') deadline.abort(new DOMException('secret-deadline-reason', 'TimeoutError')); else owner.abort(reason);
    await pending;
    expect(f.records.at(-1)).toMatchObject({ outcome: mode === 'timeout' ? 'timeout' : 'cancelled', error_code: mode === 'timeout' ? 'deadline' : 'owner_abort', body_disposition: 'incomplete' });
    const count = f.records.length; await invokeTestTool(f.surface, 'webfetch', { url: 'https://93.184.216.34' }, AbortSignal.abort(reason));
    expect(f.records).toHaveLength(count); expect(fetch).toHaveBeenCalledTimes(1); assertPrivateMetadata(f.records, ['secret-owner-reason', 'secret-deadline-reason']);
  });
  it('Analyst record preparation closure preserves global caller, never destination card', async () => {
    const f = fixture(); initProjectTree(f.root); const cards = new CardService(f.root);
    const analystToolContext = { projectRoot: f.root, actor: 'analyst', surface: 'web-chat', sessionId: 'agent:analyst:global', store: cards, interventionReadiness: { assertInterventionReady() {} }, analystMutations: testAnalystMutationServices(f.root, cards, () => ({ ok: true as const, notificationId: 'notification' })) } as never;
    const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('web', webToolBinders, { projectRoot: f.root, agentName: 'analyst', analystToolContext, outboundHttp: f.sink })]);
    const headers = deferred<Response>(); jest.spyOn(globalThis, 'fetch').mockReturnValue(headers.promise);
    const owner = testLlmToolInvocationContext({ sessionId: 'agent:analyst:global', sourceInputId: '11111111-1111-4111-8111-111111111111', toolName: 'webfetch' });
    const pending = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', save_as: 'record:///brief.md?card=project' }, undefined, owner);
    await microtasks(); expect(f.records).toHaveLength(1); expect(f.records[0]).toMatchObject(projectOutboundSource(owner.sessionId, owner.sourceInputId));
    headers.resolve(new Response('secret-record-content', { headers: { 'content-type': 'text/plain' } }));
    expect(await pending).toMatchObject({ success: true }); assertLifecycles(f.records, 1);
    for (const phase of f.records) { expect(phase).toMatchObject(projectOutboundSource(owner.sessionId, owner.sourceInputId)); expect(phase).not.toHaveProperty('source_card'); }
    expect(cards.readRecordCurrent('project', 'brief.md')).toMatchObject({ kind: 'found', value: { projection: { accepted: { content: 'secret-record-content' } } } });
    assertPrivateMetadata(f.records, ['secret-record-content', 'brief.md']);
  });
  it('throwing ordinary sink preserves successful result; fatal sink produces no dispatch effect or later log', async () => {
    const f = fixture(); const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('result', { headers: { 'content-type': 'text/plain' } }));
    for (const fatal of [false, true]) {
      const failure = fatal ? new PublicationOutcomeUnknownError() : new Error('ordinary'); const sink = jest.fn(() => { throw failure; });
      const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('web', webToolBinders, { projectRoot: f.root, agentName: 'executor', outboundHttp: sink })]);
      const pending = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34' });
      if (fatal) { await expect(pending).rejects.toBe(failure); expect(sink).toHaveBeenCalledTimes(1); }
      else { expect(await pending).toMatchObject({ success: true }); expect(sink).toHaveBeenCalledTimes(3); }
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
