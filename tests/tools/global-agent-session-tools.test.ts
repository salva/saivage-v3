import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { STRUCTURAL_ROW_POLICY, MODEL_RECOVERY_NOTICE_TEXT, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { readCurrentConversationSegment } from '../../src/persistence/index.js';
import { DiscoveryBudgetTooSmallError, DiscoveryCollectionPositionError } from '../../src/tools/response-packer.js';
import { stabilizeAgentSession } from '../../src/runtime/actors/conversation-recovery.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { globalObservationToolBinders, type GlobalObservationToolContext } from '../../src/tools/global-observation-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { CardService } from '../helpers/canonical-project.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import {
  OUTBOUND_RAW_MARKER,
  OUTBOUND_REDACTED_URL,
  OUTBOUND_URL,
} from '../helpers/outbound-identity-fixtures.js';
import { publishThreeGenerationCompactedConversation, requireCompacted } from '../helpers/compacted-conversation-fixture.js';
import { RESPONSES_A } from '../helpers/responses-producer-fixture.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { settledSuccessBytes } from '../../src/contracts/index.js';

const roots: string[] = [];
const timestamp = '2026-07-18T00:00:00.000Z';
const sourceInputId = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-agent-tool-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}
function context(projectRoot: string): ToolContext {
  return { projectRoot, store: new CardService(projectRoot), captureExecutingLlmSnapshots: () => executingLlmSnapshots(['agent:planner:project']) } as unknown as ToolContext;
}
async function invokeAgentObservation(projectRoot: string, name: 'list_agent_sessions'|'read_agent_session', args: unknown) {
  const binder = globalObservationToolBinders.find((candidate) => candidate.name === name);
  if (!binder) throw new Error(`Expected production ${name} binder.`);
  const bound = binder.bind(context(projectRoot) as unknown as GlobalObservationToolContext);
  const execution = await bound.executor(bound.inputSchema.parse(args), new AbortController().signal);
  return execution.providerOutcome;
}
function rows(): AgentMessage[] {
  return [
    {
      id: 'activation',
      session_id: 'agent:planner:project',
      role: 'system',
      kind: 'activity',
      context_policy: ACTIVITY_ROW_POLICY,
      content: JSON.stringify({
        event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' },
        agent_name: 'planner',
        card_id: 'project',
        input_id: sourceInputId,
        timestamp,
      }),
      round_id: `r-pre-${sourceInputId.replaceAll('-', '')}`,
      message_index: 0,
      block_index: 0,
      timestamp,
    },
    {
      id: 'first',
      session_id: 'agent:planner:project',
      role: 'user',
      kind: 'text',
      context_policy: TEXT_ROW_POLICY,
      content: 'first',
      round_id: `r-user-${sourceInputId.replaceAll('-', '')}`,
      message_index: 1,
      block_index: 0,
      timestamp,
    },
    {
      id: `${sourceInputId}:tool-call:call-1`,
      session_id: 'agent:planner:project',
      role: 'assistant',
      kind: 'tool_call',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '' }).call,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'webfetch', arguments: JSON.stringify({ url: OUTBOUND_URL }) },
          },
        ],
      }),
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    },
  ];
}

async function diagnosticData(root: string, session: ConversationSessionId, extra: Record<string, unknown> = {}) {
  const result = await invokeAgentObservation(root, 'read_agent_session', { session_id: session, section: 'diagnostics', ...extra });
  if (result.kind !== 'succeeded') throw new Error(result.error);
  return result.data as any;
}

function preparedActivation(session: ConversationSessionId, inputId: string, time: string, cardId: string): AgentMessage {
  return { ...rows()[0]!, id: `activation-${inputId}`, session_id: session, timestamp: time,
    content: JSON.stringify({ event: 'activation_open', agent_name: cardId === 'project' ? 'planner' : 'executor', card_id: cardId, input_id: inputId, timestamp: time,
      instructions: { kind: 'prepared', role_text: 'huge-prepared-instructions'.repeat(4000), activation_id: inputId,
        caller: cardId === 'project' ? { kind: 'root' } : { kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project', sourceInputId, toolCallId: 'call-1', toolName: 'activate_card' },
        card: { cardId, cardType: cardId === 'project' ? 'project' : 'code', title: 'huge-prepared-instructions'.repeat(1000) },
        parent_direction: cardId === 'project' ? null : { text: 'huge-prepared-instructions'.repeat(1000) },
        node: { node_id: cardId === 'project' ? 'plan' : 'execute', text: 'huge-prepared-instructions'.repeat(4000) } } }),
  };
}

function issue(session: ConversationSessionId, id: string, time: string, content: string): AgentMessage {
  return { ...rows()[1]!, id, session_id: session, timestamp: time, role: 'assistant', kind: 'model_issue', context_policy: STRUCTURAL_ROW_POLICY.provider_failure, content };
}

function callRow(session: ConversationSessionId, tool: string, callId: string, time: string, args: unknown): AgentMessage {
  return { ...rows()[2]!, id: `${sourceInputId}:tool-call:${callId}`, session_id: session, timestamp: time, tool, tool_call_id: callId,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }),
  };
}

function resultRow(session: ConversationSessionId, tool: string, callId: string, time: string, result: unknown, settlementOrigin: 'executed' | 'execution_failed' = 'executed'): AgentMessage {
  const content = JSON.stringify(result);
  return { ...rows()[2]!, id: `${sourceInputId}:tool-result:${callId}`, session_id: session, timestamp: time, role: 'tool', kind: 'tool_result', tool, tool_call_id: callId, content, context_policy: toolRowPolicies({ content, settlementOrigin }).result };
}

describe('global agent-session observation tools', () => {
  it('keeps non-activation activity ordinary and exposes canonical refusal kind without invented activation', async () => {
    const root = setup();
    const refusal = buildContentPolicyRefusalMessage({ sessionId: 'agent:planner:project', sourceInputId, candidate: { provider: 'test', account: null, model: 'test' }, providerResponse: 'Refused token=synthetic-refusal-secret' });
    appendConversationBatch({ projectRoot: root }, [rows()[0]!, { ...rows()[0]!, id: 'ordinary-activity', content: JSON.stringify({ event: 'ordinary_event', detail: 'small activity' }) }, refusal]);
    const data = await diagnosticData(root, 'agent:planner:project');
    expect(data.diagnostics.items[1]).toMatchObject({ kind: 'activity', preview: JSON.stringify({ event: 'ordinary_event', detail: 'small activity' }), preview_complete: true });
    expect(data.diagnostics.items[1]).not.toHaveProperty('activation_id');
    expect(data.diagnostics.items[1]).not.toHaveProperty('instructions_omitted');
    expect(data.diagnostics.items[2]).toMatchObject({ kind: 'content_policy_refusal', message_id: refusal.id, preview_complete: true });
    expect(JSON.parse(data.diagnostics.items[2].preview).provider_response).toBe('Refused token=[REDACTED]');
    expect(JSON.stringify(data)).not.toContain('synthetic-refusal-secret');
  });
  it('preserves real recovery settlement as uncertainty, and rejects complete malformed canonical bytes even for exact lookup', async () => {
    const root = setup();
    appendConversationBatch({ projectRoot: root }, rows());
    stabilizeAgentSession({ sessionId: 'agent:planner:project', conversations: { projectRoot: root }, terminalToolNames: new Set() });
    const data = await diagnosticData(root, 'agent:planner:project');
    expect(data.diagnostics.items.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'tool_result', success: false, settlement_origin: 'execution_failed', preview: 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.' }),
      expect.objectContaining({ kind: 'model_recovered', preview: MODEL_RECOVERY_NOTICE_TEXT, preview_complete: true }),
    ]);
    const detail = await invokeAgentObservation(root, 'read_agent_session', { session_id: 'agent:planner:project', section: 'message', message_id: `${sourceInputId}:tool-result:call-1` });
    if (detail.kind !== 'succeeded') throw new Error(detail.error);
    expect(JSON.parse((detail.data as any).message.items[0].content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    appendFileSync(cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename), '{"complete":"malformed-envelope"}\n');
    await expect(diagnosticData(root, 'agent:planner:project')).rejects.toThrow();
    await expect(invokeAgentObservation(root, 'read_agent_session', { session_id: 'agent:planner:project', section: 'message', message_id: 'first' })).rejects.toThrow();
  });
  it('navigates stale parent/worker evidence in two bounded reads, then distinguishes a fresh worker activation', async () => {
    const root = setup();
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'worker', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const worker = `agent:executor:${child.id}` as const;
    const oldTime = '2026-10-29T10:00:00.000Z';
    const newTime = '2026-11-10T10:00:00.000Z';
    const workerActivation = preparedActivation(worker, sourceInputId, oldTime, child.id);
    appendConversationBatch({ projectRoot: root }, [workerActivation, issue(worker, 'old-quota', oldTime, 'Quota exhausted; reset October 30.')]);
    const parentRows = rows();
    parentRows[0] = preparedActivation('agent:planner:project', sourceInputId, newTime, 'project');
    parentRows[1] = { ...parentRows[1]!, timestamp: newTime, content: 'The worker just failed today with quota exhausted.' };
    parentRows[2] = callRow('agent:planner:project', 'activate_card', 'call-1', newTime, { cardId: child.id, direction: 'continue' });
    parentRows.push(resultRow('agent:planner:project', 'activate_card', 'call-1', newTime, { success: true, data: { activated: true } }));
    parentRows.push(...Array.from({ length: 60 }, (_, index) => ({ ...parentRows[1]!, id: `narrative-${index}` })));
    appendConversationBatch({ projectRoot: root }, parentRows);
    const parent = await diagnosticData(root, 'agent:planner:project', { response_bytes: 6000 });
    const workerData = await diagnosticData(root, worker, { response_bytes: 6000 });
    for (const data of [parent, workerData]) {
      expect(Buffer.byteLength(settledSuccessBytes(data))).toBeLessThanOrEqual(6000);
      expect(JSON.stringify(data)).not.toContain('content_hex');
      expect(JSON.stringify(data)).not.toContain('huge-prepared-instructions');
      expect(data.diagnostics.next).toBeNull();
      expect(data.omitted_earlier_diagnostic_entries).toBe(0);
    }
    expect(parent.total_visible_entries).toBe(64);
    expect(parent.total_diagnostic_entries).toBe(3);
    expect(parent.diagnostics.items.map((item: any) => item.kind)).toEqual(['activity', 'tool_call', 'tool_result']);
    expect(parent.diagnostics.items[2]).toMatchObject({ success: true, settlement_origin: 'executed' });
    const defaultTail = await invokeAgentObservation(root, 'read_agent_session', { session_id: 'agent:planner:project' });
    if (defaultTail.kind !== 'succeeded') throw new Error(defaultTail.error);
    expect((defaultTail.data as any).messages.items.some((row: any) => row.id === parentRows[2]!.id)).toBe(false);
    const exactCall = await invokeAgentObservation(root, 'read_agent_session', { session_id: 'agent:planner:project', section: 'message', message_id: parentRows[2]!.id });
    expect(exactCall).toMatchObject({ kind: 'succeeded', data: { entry_origin: 'segment_row', message: { total: 1, items: [expect.objectContaining({ id: parentRows[2]!.id, kind: 'tool_call' })] } } });
    expect(workerData.diagnostics.items).toEqual([
      expect.objectContaining({ timestamp: oldTime, instructions_omitted: true, instructions: { kind: 'prepared', activation_id: sourceInputId, node_id: 'execute', caller: { kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project', sourceInputId, toolCallId: 'call-1', toolName: 'activate_card' } } }),
      expect.objectContaining({ timestamp: oldTime, preview: 'Quota exhausted; reset October 30.', preview_complete: true }),
    ]);
    expect(workerData.diagnostics.items.some((item: any) => item.kind === 'activity' && item.timestamp === newTime)).toBe(false);
    const freshId = '22222222-2222-4222-8222-222222222222';
    appendConversationBatch({ projectRoot: root }, [preparedActivation(worker, freshId, newTime, child.id), issue(worker, 'fresh-failure', newTime, 'Fresh worker failure.')]);
    const fresh = await diagnosticData(root, worker);
    expect(fresh.diagnostics.items.slice(-2)).toEqual([
      expect.objectContaining({ timestamp: newTime, instructions: expect.objectContaining({ activation_id: freshId }), message_id: `activation-${freshId}` }),
      expect.objectContaining({ timestamp: newTime, preview: 'Fresh worker failure.' }),
    ]);
  });

  it('pages whole factual call/result rows without pairing, with exact coverage and budget failures', async () => {
    const root = setup();
    const session = 'agent:planner:project';
    const history = [rows()[0]!, callRow(session, 'webfetch', 'call-1', timestamp, { url: OUTBOUND_URL }),
      resultRow(session, 'webfetch', 'call-1', timestamp, { success: false, error: 'Effects unknown; do not replay.' }, 'execution_failed'),
      issue(session, 'small-issue', timestamp, 'small')];
    appendConversationBatch({ projectRoot: root }, history);
    const selected = await diagnosticData(root, session, { last_n: 3 });
    expect(selected).toMatchObject({ scope: 'current_segment_rows', total_visible_entries: 4, total_diagnostic_entries: 4, selected_diagnostic_entries: 3, omitted_earlier_diagnostic_entries: 1, first_message_id: history[1]!.id, last_message_id: 'small-issue', first_timestamp: timestamp, last_timestamp: timestamp, inherited_notices_included: false, historical_segments_included: false });
    const cap = Buffer.byteLength(settledSuccessBytes({ ...selected, diagnostics: { total: 3, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: { item_index: 1, item_byte_offset: 0 }, items: [selected.diagnostics.items[0]] } }));
    const observed: any[] = [];
    let position: any = undefined;
    do {
      const page = await diagnosticData(root, session, { last_n: 3, response_bytes: cap, ...(position ? { position } : {}) });
      expect(Buffer.byteLength(settledSuccessBytes(page))).toBeLessThanOrEqual(cap);
      expect(JSON.stringify(page)).not.toContain('content_hex');
      expect(page.diagnostics.position).toEqual(position ?? { item_index: 0, item_byte_offset: 0 });
      expect(await diagnosticData(root, session, { last_n: 3, response_bytes: cap, ...(position ? { position } : {}) })).toEqual(page);
      observed.push(...page.diagnostics.items);
      position = page.diagnostics.next;
    } while (position);
    expect(observed).toEqual(selected.diagnostics.items);
    expect(observed[1]).toMatchObject({ kind: 'tool_result', success: false, settlement_origin: 'execution_failed', preview: 'Effects unknown; do not replay.' });
    await expect(diagnosticData(root, session, { response_bytes: 512 })).rejects.toThrow(DiscoveryBudgetTooSmallError);
    await expect(diagnosticData(root, session, { position: { item_index: 0, item_byte_offset: 1 } })).rejects.toThrow(DiscoveryCollectionPositionError);
    await expect(invokeAgentObservation(root, 'read_agent_session', { session_id: session, section: 'message', message_id: 'missing' })).resolves.toMatchObject({ kind: 'failed', data: { code: 'agent_message_not_found', segment_id: selected.segment_id, segment_version: selected.segment_version } });
    await expect(invokeAgentObservation(root, 'read_agent_session', { session_id: session, section: 'message', message_id: history[0]!.id, last_n: 1 })).rejects.toThrow();
  });

  it('redacts whole Unicode failures before stable previews and reconstructs exact public message slices', async () => {
    const root = setup();
    const content = `${'é'.repeat(248)} token=secret-spanning-cutoff ${'🚀"\\\n'.repeat(600)}`;
    appendConversationBatch({ projectRoot: root }, [rows()[0]!, callRow('agent:planner:project', 'webfetch', 'call-1', timestamp, {}), resultRow('agent:planner:project', 'webfetch', 'call-1', timestamp, { success: false, error: content })]);
    const data = await diagnosticData(root, 'agent:planner:project', { last_n: 1 });
    const preview = data.diagnostics.items[0];
    const original = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map()).getConversation('agent:planner:project').entries.at(-1)!;
    const publicError = JSON.parse(original.content).error;
    expect(publicError).not.toContain('secret-spanning-cutoff');
    expect(publicError).toContain('[REDACTED]');
    expect(publicError.startsWith(preview.preview)).toBe(true);
    expect(preview).toMatchObject({ preview_complete: false, content_utf8_bytes: Buffer.byteLength(publicError), preview_utf8_bytes: Buffer.byteLength(preview.preview) });
    expect(preview.preview_utf8_bytes).toBeLessThanOrEqual(512);
    expect(preview.preview).toBe(`${'é'.repeat(248)} `);
    expect(preview.preview).not.toContain('\uFFFD');
    const chunks: Buffer[] = [];
    let position: any;
    do {
      const response = await invokeAgentObservation(root, 'read_agent_session', { session_id: 'agent:planner:project', section: 'message', message_id: original.id, response_bytes: 1200, ...(position ? { position } : {}) });
      if (response.kind !== 'succeeded') throw new Error(response.error);
      const detail = response.data as any;
      expect(detail.entry_origin).toBe('segment_row');
      expect(detail).not.toHaveProperty('original_event_metadata');
      expect(Buffer.byteLength(settledSuccessBytes(detail))).toBeLessThanOrEqual(1200);
      for (const item of detail.message.items) chunks.push(item.content_hex ? Buffer.from(item.content_hex, 'hex') : Buffer.from(JSON.stringify(item)));
      position = detail.message.next;
    } while (position);
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(original);
    const historical = projectToolInvocation({ shape: 'result-row', identity: { sessionId: 'agent:analyst:global', sourceInputId, toolCallId: 'nested', toolName: 'read_agent_session' }, result: { success: true, data } });
    expect(historical).toMatchObject({ result: { success: true, data } });
  });

  it('excludes real inherited synthesized notices, labels exact notice lookup, and includes post-compaction evidence', async () => {
    const root = setup();
    const session = await publishThreeGenerationCompactedConversation(root);
    const messages = await invokeAgentObservation(root, 'read_agent_session', { session_id: session, last_n: 1000 });
    if (messages.kind !== 'succeeded') throw new Error(messages.error);
    const visible = (messages.data as any).messages.items;
    const segment = readCurrentConversationSegment(root, session)!;
    const actualIds = new Set(segment.rows.map(row => row.id));
    const carried = visible.filter((row: any) => !actualIds.has(row.id));
    expect(carried).toHaveLength(2);
    const diagnostic = await diagnosticData(root, session, { last_n: 1000 });
    expect(diagnostic.total_visible_entries).toBe(visible.length);
    expect(diagnostic.inherited_notices_included).toBe(false);
    expect(diagnostic.total_diagnostic_entries).toBe(diagnostic.diagnostics.items.length);
    expect(diagnostic.diagnostics.items.every((row: any) => actualIds.has(row.message_id))).toBe(true);
    for (const notice of carried) {
      const detail = await invokeAgentObservation(root, 'read_agent_session', { session_id: session, section: 'message', message_id: notice.id });
      expect(detail).toMatchObject({ kind: 'succeeded', data: { entry_origin: 'carried_synthesized_notice', original_event_metadata: 'not_available', message: { items: [notice] } } });
    }
    appendConversationBatch({ projectRoot: root }, [{ ...rows()[1]!, id: 'long-post-compaction-text', content: 'context '.repeat(4000) }]);
    await requireCompacted(root, 'local_exact_admission', 'all source rows summarized', 0);
    const noRows = await diagnosticData(root, session);
    expect(noRows).toMatchObject({ has_segment_context: true, total_diagnostic_entries: 0, selected_diagnostic_entries: 0, omitted_earlier_diagnostic_entries: 0, first_message_id: null, last_message_id: null, first_timestamp: null, last_timestamp: null, historical_segments_included: false, inherited_notices_included: false, diagnostics: { total: 0, returned: 0, next: null, items: [] } });
    expect(noRows.total_visible_entries).toBeGreaterThanOrEqual(2);
    // A segment with no matching row still discloses scope, not lifetime absence.
    const emptyRoot = setup();
    appendConversationBatch({ projectRoot: emptyRoot }, [rows()[1]!]);
    expect(await diagnosticData(emptyRoot, session)).toMatchObject({ total_visible_entries: 1, total_diagnostic_entries: 0, selected_diagnostic_entries: 0, first_message_id: null, last_message_id: null, first_timestamp: null, last_timestamp: null, inherited_notices_included: false, historical_segments_included: false, diagnostics: { items: [], next: null } });
    appendConversationBatch({ projectRoot: root }, [issue(session, 'after-compaction', '2026-11-10T12:00:00.000Z', 'new failure')]);
    expect((await diagnosticData(root, session, { last_n: 1 })).diagnostics.items).toEqual([expect.objectContaining({ message_id: 'after-compaction', timestamp: '2026-11-10T12:00:00.000Z', origin: 'segment_row' })]);
  });

  it('returns a strict compacted current session through the production binder and executor', async () => {
    const projectRoot = setup();
    const sessionId = await publishThreeGenerationCompactedConversation(projectRoot, 'fixture compacted summary token=tool-summary-canary final-summary-Z', {
      first: { content: 'token=obsolete-tool-context-secret', key: 'api_key=tool-context-key-secret' },
      replacement: { content: 'token=current-tool-context-secret', key: 'api_key=tool-context-key-secret' },
    }, RESPONSES_A);
    const binder = globalObservationToolBinders.find((candidate) => candidate.name === 'read_agent_session');
    if (!binder) throw new Error('Expected production read_agent_session binder.');
    const bound = binder.bind(context(projectRoot) as unknown as GlobalObservationToolContext);
    const args = bound.inputSchema.parse({ session_id: sessionId });
    const execution = await bound.executor(args, new AbortController().signal);

    expect(execution.evidence).toEqual({ kind: 'observational_result_bytes' });
    expect(execution.providerOutcome.kind).toBe('succeeded');
    if (execution.providerOutcome.kind !== 'succeeded')
      throw new Error(execution.providerOutcome.error);
    const data = execution.providerOutcome.data as any;
    expect(JSON.stringify(data)).not.toContain('producer_account_id');
    expect(JSON.stringify(data)).not.toContain(responsesProducerAccountId(RESPONSES_A));
    expect(JSON.stringify(data)).not.toContain('ciphertext-');
    expect(JSON.stringify(data)).toContain('retained-tool');
    expect(Object.keys(data).sort()).toEqual([
      'has_segment_context',
      'messages',
      'ownership',
      'section',
      'segment_id',
      'segment_version',
      'session',
      'total_visible_entries',
    ]);
    expect(data.segment_version).toBe(3);
    expect(data).toMatchObject({section:'messages',has_segment_context:true});
    const contextExecution=await bound.executor(bound.inputSchema.parse({session_id:sessionId,section:'context'}),new AbortController().signal);
    expect(contextExecution.providerOutcome.kind).toBe('succeeded');
    if(contextExecution.providerOutcome.kind!=='succeeded')throw new Error(contextExecution.providerOutcome.error);
    const contextData=contextExecution.providerOutcome.data as any;
    expect(contextData).toMatchObject({section:'context',has_segment_context:true,context:{total:1,returned:1}});
    const segmentContext = contextData.context.items[0];
    expect(segmentContext.summary_text).toBe('fixture compacted summary token=[REDACTED] final-summary-Z');
    expect(JSON.stringify(contextData)).not.toContain('tool-summary-canary');
    expect(Object.keys(segmentContext).sort()).toEqual([
      'continuation',
      'covered_through_message_id',
      'kind',
      'protected_prompts',
      'required_model_facts',
      'source_version',
      'summary_text',
    ]);
    expect(segmentContext.protected_prompts).toHaveLength(1);
    expect(segmentContext.protected_prompts[0]).toMatchObject({
      source: { segment_version: 2, row_index: 2 },
      message: {
        id: 'protected-2',
        content: 'token=[REDACTED]',
        context_policy: { kind: 'content', compactable: false, compaction_key: 'api_key=[REDACTED]' },
      },
    });
    expect(JSON.stringify(contextData)).not.toContain('obsolete-tool-context-secret');
    expect(JSON.stringify(contextData)).not.toContain('current-tool-context-secret');
    expect(JSON.stringify(contextData)).not.toContain('tool-context-key-secret');
    expect(Object.keys(segmentContext.required_model_facts).sort()).toEqual([
      'latestContentPolicyRefusal',
      'latestRecordObservations',
      'latestRecovery',
    ]);
    expect(segmentContext.required_model_facts.latestRecovery).not.toBeNull();
    expect(segmentContext.required_model_facts.latestRecordObservations).toEqual([]);
    expect(Object.keys(segmentContext.required_model_facts.latestRecovery!).sort()).toEqual([
      'activationInputId',
      'sourceMessageId',
    ]);
    expect(segmentContext.required_model_facts.latestContentPolicyRefusal).not.toBeNull();
    expect(Object.keys(segmentContext.required_model_facts.latestContentPolicyRefusal!).sort()).toEqual([
      'activationInputId',
      'markerId',
    ]);
    expect(segmentContext.source_version).toBe(2);
    expect(segmentContext.continuation.kind).toBe('inherited_open_round');
    if (segmentContext.continuation.kind !== 'inherited_open_round')
      throw new Error('Expected inherited open-round continuation.');
    expect(Object.keys(segmentContext.continuation).sort()).toEqual([
      'activation',
      'active_segment_kind',
      'kind',
    ]);
    expect(Object.keys(segmentContext.continuation.activation).sort()).toEqual(['input_id', 'marker_id']);
    expect(segmentContext.continuation.activation).not.toHaveProperty('inputId');
    expect(segmentContext.continuation.activation).not.toHaveProperty('markerId');
  });

  it('returns the exact direct and nested durable call-only tail', async () => {
    const projectRoot = setup();
    appendConversationBatch({ projectRoot }, rows());
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => executingLlmSnapshots(['agent:planner:project']));
    const expected = service.getConversation('agent:planner:project');
    const detail = service.getSession('agent:planner:project');
    const result = await invokeAgentObservation(projectRoot, 'read_agent_session', {
      session_id: 'agent:planner:project',
      last_n: 1,
    });
    expect(result).toEqual({
      kind: 'succeeded',
      data: {
        session: detail.session,
        ownership: 'active',
        segment_version: 1,
        segment_id: expect.any(String),
        section: 'messages',
        has_segment_context: false,
        total_visible_entries: 3,
        messages: expect.objectContaining({ total: 1, returned: 1, items: [expected.entries[2]] }),
      },
    });
    if (result.kind !== 'succeeded') throw new Error(result.error);
    expect((result.data as any).session).toEqual(expect.objectContaining({ status: 'active', activity: 'busy' }));
    expect(JSON.stringify(result)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(result)).toContain(OUTBOUND_REDACTED_URL);
    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: {
        sessionId: 'agent:analyst:global',
        sourceInputId: '22222222-2222-4222-8222-222222222222',
        toolCallId: 'nested-durable',
        toolName: 'read_agent_session',
      },
      result: { success: true, data: result.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success)
      throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toMatchObject({
      total_visible_entries: 3,
      messages: expect.objectContaining({ total: 1, returned: 1, items: [expect.objectContaining({ id: rows()[2]!.id, kind: 'tool_call' })] }),
    });
    expect(JSON.stringify(nested.result.data)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('preserves an exact result-only tail and reprojects it identically when nested historically', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: 'agent:planner:project',
      role: 'tool',
      kind: 'tool_result',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '{"success":false,"error":"failed token=synthetic-result-secret"}' }).result,
      content: '{"success":false,"error":"failed token=synthetic-result-secret"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const direct = await invokeAgentObservation(projectRoot, 'read_agent_session', {
      session_id: 'agent:planner:project',
      last_n: 1,
    });
    expect(direct).toMatchObject({ kind: 'succeeded', data: { total_visible_entries: 4, messages: { total: 1, returned: 1 } } });
    if (direct.kind !== 'succeeded') throw new Error(direct.error);
    expect((direct.data as any).messages.items[0]!.kind).toBe('tool_result');
    expect(JSON.stringify(direct)).not.toContain('synthetic-result-secret');

    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: {
        sessionId: 'agent:analyst:global',
        sourceInputId: '22222222-2222-4222-8222-222222222222',
        toolCallId: 'nested-read',
        toolName: 'read_agent_session',
      },
      result: { success: true, data: direct.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success)
      throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toMatchObject({
      total_visible_entries: 4,
      messages: expect.objectContaining({ total: 1, returned: 1, items: [expect.objectContaining({ kind: 'tool_result' })] }),
    });
    const nestedMessage = (nested.result.data as any).messages.items[0]!;
    expect(() => JSON.parse(nestedMessage.content)).not.toThrow();
    expect(nestedMessage.content).not.toContain('synthetic-result-secret');
  });

  it('keeps complete-pair tail boundaries, totals, ordering, and parse counts exact', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: 'agent:planner:project',
      role: 'tool',
      kind: 'tool_result',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '{"success":false,"error":"settled"}' }).result,
      content: '{"success":false,"error":"settled"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const projected = await invokeAgentObservation(projectRoot, 'read_agent_session', {
      session_id: 'agent:planner:project',
      last_n: 2,
    });
    expect(projected).toMatchObject({
      kind: 'succeeded',
      data: {
        total_visible_entries: 4,
        messages: { total: 2, returned: 2, items: [expect.objectContaining({ kind: 'tool_call' }), expect.objectContaining({ kind: 'tool_result' })] },
      },
    });
  });

  it('byte-packs a large session entry with a stateless continuation position', async()=>{
    const projectRoot=setup();const large=rows();large[1]={...large[1]!,content:'x'.repeat(20_000)};appendConversationBatch({projectRoot},large);
    const first=await invokeAgentObservation(projectRoot,'read_agent_session',{session_id:'agent:planner:project',last_n:3,response_bytes:1024});
    expect(first.kind).toBe('succeeded');if(first.kind!=='succeeded')throw new Error(first.error);
    const page=(first.data as any).messages;
    expect(page.total).toBe(3);expect(page.next).not.toBeNull();
    expect(Buffer.byteLength(settledSuccessBytes(first.data),'utf8')).toBeLessThanOrEqual(1024);
    const second=await invokeAgentObservation(projectRoot,'read_agent_session',{session_id:'agent:planner:project',last_n:3,response_bytes:1024,position:page.next});
    expect(second).toMatchObject({kind:'succeeded',data:{messages:{position:page.next}}});
    if(second.kind!=='succeeded')throw new Error(second.error);
    expect(Buffer.byteLength(settledSuccessBytes(second.data),'utf8')).toBeLessThanOrEqual(1024);
  });

  it('pages a complete oversized compacted context independently without leaking secret text',async()=>{
    const projectRoot=setup();
    const marker='context-secret-token';
    const sessionId=await publishThreeGenerationCompactedConversation(projectRoot,`token=${marker} ${'history '.repeat(300)}`);
    let position:undefined|{item_index:number;item_byte_offset:number}=undefined;
    const chunks:Buffer[]=[];
    do{
      const result=await invokeAgentObservation(projectRoot,'read_agent_session',{session_id:sessionId,section:'context',response_bytes:1024,...(position?{position}:{})});
      expect(result.kind).toBe('succeeded');if(result.kind!=='succeeded')throw new Error(result.error);
      expect(Buffer.byteLength(settledSuccessBytes(result.data),'utf8')).toBeLessThanOrEqual(1024);
      const page=(result.data as any).context;
      expect(page.total).toBe(1);
      for(const item of page.items){
        if(typeof item.content_hex==='string')chunks.push(Buffer.from(item.content_hex,'hex'));
        else chunks.push(Buffer.from(JSON.stringify(item),'utf8'));
      }
      position=page.next??undefined;
    }while(position);
    const reconstructed=Buffer.concat(chunks).toString('utf8');
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(reconstructed,'utf8')).toBeGreaterThan(1024);
    expect(()=>JSON.parse(reconstructed)).not.toThrow();
    expect(reconstructed).not.toContain(marker);
    expect(reconstructed).toContain('[REDACTED]');
    await expect(invokeAgentObservation(projectRoot,'read_agent_session',{session_id:sessionId,section:'context',last_n:1})).rejects.toThrow();
  });

  it('fails noncanonical and absent exact identities without synthesizing a session', async () => {
    const projectRoot = setup();
    await expect(
      invokeAgentObservation(projectRoot, 'read_agent_session', { session_id: 'planner:not_valid' as never }),
    ).rejects.toThrow();
    await expect(
      invokeAgentObservation(projectRoot, 'read_agent_session', { session_id: 'agent:planner:project' }),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: 'Agent session has no current conversation segment.',
      data: { code: 'agent_session_empty', session_id: 'agent:planner:project' },
    });
  });

  it('uses authoritative inventory for listing while retaining direct tombstoned history', async () => {
    const projectRoot = setup();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'child',
      bootstrap_content: 'brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const sessionId = `agent:executor:${child.id}` as const;
    appendConversationBatch({ projectRoot }, [
      {
        ...rows()[0]!,
        id: 'child-activation',
        session_id: sessionId,
        content: JSON.stringify({
          event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' },
          agent_name: 'executor',
          card_id: child.id,
          input_id: sourceInputId,
          timestamp,
        }),
      },
    ]);
    await expect(invokeAgentObservation(projectRoot, 'list_agent_sessions', {})).resolves.toMatchObject({
      kind: 'succeeded',
      data: { sessions: { items: [expect.objectContaining({ id: sessionId })] } },
    });
    cards.deleteSubtrees([child.id], () => true);
    await expect(invokeAgentObservation(projectRoot, 'list_agent_sessions', {})).resolves.toMatchObject({
      kind: 'succeeded',
      data: { sessions: { total: 0, returned: 0, items: [] } },
    });
    await expect(invokeAgentObservation(projectRoot, 'read_agent_session', { session_id: sessionId })).resolves.toMatchObject({
      kind: 'succeeded',
      data: { session: { id: sessionId } },
    });
  });

});
