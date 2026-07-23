import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService, captureExecutingLlmSnapshotMap } from '../../src/application/read-models/agent-operator-read-model.js';
import { projectAgentConversationForOutbound } from '../../src/application/read-models/agent-conversation-outbound.js';
import { CardService } from '../helpers/canonical-project.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import type { ExactWaitBarrier, ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { OUTBOUND_RAW_MARKER, OUTBOUND_REDACTED_URL, OUTBOUND_URL } from '../helpers/outbound-identity-fixtures.js';

const timestamp = '2026-07-18T00:00:00.000Z';
const inputId = '11111111-1111-4111-8111-111111111111';
let roots: string[] = [];

afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function project() { const root = mkdtempSync(join(tmpdir(), 'saivage-agent-read-')); roots.push(root); initProjectTree(root); return root; }
function text(session_id: ConversationSessionId): AgentMessage { return { id: `${session_id}:text`, session_id, role: 'user', kind: 'text', content: 'hello', round_id: `r-user-${inputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp }; }
function call(session_id: ConversationSessionId, tool = 'webfetch', toolCallId = 'call-1', args: Record<string, unknown> = { url: 'https://example.com' }): AgentMessage { return { id: `${inputId}:tool-call:${toolCallId}`, session_id, role: 'assistant', kind: 'tool_call', tool, tool_call_id: toolCallId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }), round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp }; }
function result(session_id: ConversationSessionId, tool = 'webfetch', toolCallId = 'call-1'): AgentMessage { return { id: `${inputId}:tool-result:${toolCallId}`, session_id, role: 'tool', kind: 'tool_result', tool, tool_call_id: toolCallId, content: '{"success":false,"error":"failed token=synthetic-result-secret"}', round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 1, block_index: 0, timestamp }; }
function snapshot(sessionId: ConversationSessionId, activity: ExecutingLlmSnapshot['activity']): ExecutingLlmSnapshot { const identity=conversationSessionIdentity(sessionId); return { sessionId, agentId: sessionId, agentName: identity.agentName, cardId: identity.cardId, activity }; }
function readModel(root:string,snapshots:()=>readonly ExecutingLlmSnapshot[]){return new AgentOperatorReadModelService(root,snapshots,TEST_WORKFLOWS);}
function initialRows(sessionId: ConversationSessionId): AgentMessage[] { return sessionId === 'agent:analyst:global' ? [...buildAnalystIngressRows(sessionId,inputId, 'workspace', 'question')] : [text(sessionId)]; }
function sessionCall(sessionId: ConversationSessionId, args: Record<string, unknown>): AgentMessage { const row = call(sessionId, 'webfetch', 'call-1', args); return sessionId === 'agent:analyst:global' ? { ...row, message_index: 3 } : row; }
function conversationBody(result: ReturnType<AgentOperatorReadModelService['getConversation']>) { if (result.statusCode === 400 || result.statusCode === 404) throw new Error(result.body.error); return result.body; }
function detailBody(result: ReturnType<AgentOperatorReadModelService['getSession']>) { if (result.statusCode === 400 || result.statusCode === 404) throw new Error(result.body.error); return result.body; }

describe('AgentOperatorReadModelService snapshot-first exact projection', () => {
  it.each(['detail', 'conversation'] as const)('maps only ENOENT to the existing direct %s 404', (operation) => {
    const invoke = (root: string) => {
      const service = readModel(root, () => []);
      return operation === 'detail' ? service.getSession('agent:planner:project') : service.getConversation('agent:planner:project');
    };

    const missingRoot = project();
    expect(invoke(missingRoot)).toEqual({ statusCode: 404, body: { error: 'Agent session not found' } });

    const malformedRoot = project();
    writeFileSync(conversationFile(malformedRoot, 'agent:planner:project'), '{malformed}\n');
    expect(() => invoke(malformedRoot)).toThrow(/malformed/);

    const symlinkRoot = project();
    const referent = join(symlinkRoot, 'conversation-referent.jsonl');
    writeFileSync(referent, 'referent-original');
    symlinkSync(referent, conversationFile(symlinkRoot, 'agent:planner:project'));
    expect(() => invoke(symlinkRoot)).toThrow();
    expect(readFileSync(referent, 'utf8')).toBe('referent-original');

    const directoryRoot = project();
    mkdirSync(conversationFile(directoryRoot, 'agent:planner:project'));
    expect(() => invoke(directoryRoot)).toThrow();

    const fifoRoot = project();
    expect(spawnSync('mkfifo', [conversationFile(fifoRoot, 'agent:planner:project')]).status).toBe(0);
    expect(() => invoke(fifoRoot)).toThrow(/regular file/);
  });

  it.each(['detail', 'conversation'] as const)('performs one canonical acquisition for direct %s projection', (operation) => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'conversation-direct-read-count-child.ts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, operation], { cwd: process.cwd(), encoding: 'utf8' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Direct conversation read-count child failed (${child.status}): ${child.stderr || child.stdout}`);
    expect(JSON.parse(child.stdout.trim())).toEqual({ openAttempts: 1, descriptorReads: 1, pathReads: 0, closes: 1, statusCode: 200 });
  });

  it('projects inactive, active, and exact waiting identically across list/detail/conversation', () => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [call('agent:planner:project')]);
    const barrier = { kind: 'external' as const, sessionId: 'agent:planner:project' as const, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    const owner = { value: snapshot('agent:planner:project', { mode: 'waiting', barrier }) };
    const service = readModel(root, () => [owner.value]);
    const listed = service.listSessions().sessions.find((row) => row.id === 'agent:planner:project')!;
    const detail = detailBody(service.getSession('agent:planner:project')).session;
    const conversation = conversationBody(service.getConversation('agent:planner:project'));
    expect(listed.status).toBe('waiting');
    expect(detail.status).toBe('waiting');
    expect(conversation.session).toEqual(listed);
    expect(conversation.activity_status).toEqual({ status: 'waiting', pending_calls: [{ id: 'call-1', tool: 'webfetch', started_at: timestamp }] });
    owner.value = snapshot('agent:planner:project', { mode: 'active', barrier: null });
    expect(conversationBody(service.getConversation('agent:planner:project'))).toMatchObject({ session: { status: 'active' }, activity_status: { status: 'active', pending_calls: [] } });
    owner.value = undefined as never;
    expect(() => readModel(root, () => []).getConversation('agent:planner:project')).toThrow('undeclared result-absent');
  });

  it('projects selected models consistently across aggregate and direct reads', () => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [text('agent:planner:project')]);
    appendConversationBatch({ projectRoot: root }, [text('agent:reviewer:project')]);
    appendAppLogEntry(root, 'provider_exchange', () => providerExchange('agent:planner:project', 'planner-old', timestamp, 4));
    appendAppLogEntry(root, 'provider_exchange', () => providerExchange('agent:planner:project', 'planner-current', '2026-07-18T00:00:01.000Z', 0));
    appendAppLogEntry(root, 'provider_exchange', () => providerExchange('agent:reviewer:project', 'reviewer-current', timestamp, 2));

    const service = readModel(root, () => []);
    expect(service.listSessions().sessions).toEqual([
      expect.objectContaining({ id: 'agent:planner:project', model: 'planner-current' }),
      expect.objectContaining({ id: 'agent:reviewer:project', model: 'reviewer-current' }),
    ]);
    expect(detailBody(service.getSession('agent:planner:project')).session.model).toBe('planner-current');
    expect(conversationBody(service.getConversation('agent:reviewer:project')).session.model).toBe('reviewer-current');
  });

  it('filters provider-private rows, redacts ordinary prose, and preserves session/model/entity identities', () => {
    const visible = {
      ...text('agent:planner:project'),
      content: 'visible token=synthetic-message-secret',
      model_spec: 'sk-model',
      links: [{ entity_type: 'process' as const, entity_id: 'tok_primary', label: 'label token=synthetic-label-secret' }],
    };
    const privateRow: AgentMessage = {
      ...text('agent:planner:project'),
      id: 'private-row',
      role: 'system',
      kind: 'provider_private',
      content: 'provider token=synthetic-private-secret',
      message_index: 1,
    };
    const projected = projectAgentConversationForOutbound({ sessionId: 'agent:planner:project', messages: [visible, privateRow], model: 'tok_primary' });
    expect(projected).toMatchObject({ session: { id: 'agent:planner:project', card_id: 'project', model: 'tok_primary' }, entries: [{ model_spec: 'sk-model', links: [{ entity_id: 'tok_primary' }] }] });
    expect(projected.entries).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain('synthetic-message-secret');
    expect(JSON.stringify(projected)).not.toContain('synthetic-label-secret');
    expect(JSON.stringify(projected)).not.toContain('synthetic-private-secret');
  });

  it('omits tombstoned inventory while exact direct history remains inactive', () => {
    const root = project();
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const sessionId = `agent:executor:${child.id}` as ConversationSessionId;
    appendConversationBatch({ projectRoot: root }, [text(sessionId)]);
    const service = readModel(root, () => []);
    expect(service.listSessions().sessions.map(({ id }) => id)).toContain(sessionId);
    cards.deleteSubtrees([child.id], () => true);
    expect(service.listSessions().sessions.map(({ id }) => id)).not.toContain(sessionId);
    expect(conversationBody(service.getConversation(sessionId))).toMatchObject({ session: { id: sessionId, status: 'inactive' }, activity_status: { status: 'inactive', pending_calls: [] } });
  });

  it('enforces aggregate completeness without applying it to unrelated direct reads', () => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [text('agent:planner:project')]);
    const missing = snapshot('agent:executor:card-a', { mode: 'active', barrier: null });
    const service = readModel(root, () => [missing]);
    expect(() => service.listSessions()).toThrow("Executing agent snapshot 'agent:executor:card-a' has no aggregate conversation row");
    expect(conversationBody(service.getConversation('agent:planner:project'))).toMatchObject({ session: { status: 'inactive' } });
  });

  it('returns every conversation from a large active-card aggregate in stable ID order', () => {
    const root = project();
    const cards = new CardService(root);
    const sessionIds: ConversationSessionId[] = [];
    for (let index = 0; index < 30; index += 1) {
      const child = cards.create({ type: 'code', parent: 'project', title: `child-${index}`, bootstrap_content: 'brief', tags: [], priority: index, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const sessionId = `agent:executor:${child.id}` as ConversationSessionId;
      sessionIds.push(sessionId);
      appendConversationBatch({ projectRoot: root }, [text(sessionId)]);
    }
    expect(readModel(root, () => []).listSessions().sessions.map(({ id }) => id)).toEqual([...sessionIds].sort());
  });

  it('captures one frozen activity and rejects exact call identity mismatches', () => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [call('agent:planner:project')]);
    const owner = { value: snapshot('agent:planner:project', { mode: 'active', barrier: null }) };
    const captured = captureExecutingLlmSnapshotMap([owner.value]);
    expect(Object.isFrozen(captured.get('agent:planner:project'))).toBe(true);
    expect(Object.isFrozen(captured.get('agent:planner:project')!.activity)).toBe(true);
    owner.value = snapshot('agent:planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'wrong', toolName: 'webfetch' } });
    expect(projectAgentConversationForOutbound({ sessionId: 'agent:planner:project', messages: [call('agent:planner:project')], model: null, snapshot: captured.get('agent:planner:project') })).toMatchObject({ activity_status: { status: 'active' } });
    const mismatch = snapshot('agent:planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'wrong', toolName: 'webfetch' } });
    expect(() => readModel(root, () => [mismatch]).getConversation('agent:planner:project')).toThrow('does not match its exact barrier');
  });

  it.each(['agent:analyst:global', 'agent:planner:project'] as const)('captures active %s once before acquisition and projects zero or one acquired call', (sessionId) => {
    const beforeRoot = project();
    appendConversationBatch({ projectRoot: beforeRoot }, initialRows(sessionId));
    const active = snapshot(sessionId, { mode: 'active', barrier: null });
    expect(conversationBody(readModel(beforeRoot, () => [active]).getConversation(sessionId)))
      .toMatchObject({ session: { id: sessionId, status: 'active' }, activity_status: { status: 'active', pending_calls: [] } });

    const duringRoot = project();
    appendConversationBatch({ projectRoot: duringRoot }, initialRows(sessionId));
    let captures = 0;
    const service = readModel(duringRoot, () => {
      captures += 1;
      const captured = snapshot(sessionId, { mode: 'active', barrier: null });
      appendConversationBatch({ projectRoot: duringRoot }, [sessionCall(sessionId, { url: OUTBOUND_URL })]);
      return [captured];
    });
    const projected = conversationBody(service.getConversation(sessionId));
    expect(captures).toBe(1);
    expect(projected.activity_status).toEqual({ status: 'active', pending_calls: [] });
    expect(projected.entries.at(-1)).toMatchObject({ session_id: sessionId, tool: 'webfetch', tool_call_id: 'call-1' });
    expect(projected.entries.at(-1)!.content).toContain(OUTBOUND_REDACTED_URL);
    expect(projected.entries.at(-1)!.content).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it.each(['agent:analyst:global', 'agent:planner:project'] as const)('publishes only the exact frozen waiting %s call while later activity changes', (sessionId) => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [...initialRows(sessionId), sessionCall(sessionId, { url: OUTBOUND_URL })]);
    const barrier = { kind: 'external' as const, sessionId, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    const owner = { value: snapshot(sessionId, { mode: 'waiting', barrier }) };
    const service = readModel(root, () => {
      const captured = owner.value;
      owner.value = snapshot(sessionId, { mode: 'active', barrier: null });
      return [captured];
    });
    const projected = conversationBody(service.getConversation(sessionId));
    expect(projected.activity_status).toEqual({ status: 'waiting', pending_calls: [{ id: 'call-1', tool: 'webfetch', started_at: timestamp }] });
    expect(projected.entries.at(-1)!.content).not.toContain(OUTBOUND_RAW_MARKER);
    expect(projected.entries.at(-1)!.content).toContain(OUTBOUND_REDACTED_URL);
  });

  it.each(['aggregate', 'direct'] as const)('captures waiting before %s row acquisition and finds the already-published call', (kind) => {
    const root = project();
    const barrier = { kind: 'external' as const, sessionId: 'agent:planner:project' as const, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    let captures = 0;
    const service = readModel(root, () => {
      captures += 1;
      appendConversationBatch({ projectRoot: root }, [call('agent:planner:project')]);
      return [snapshot('agent:planner:project', { mode: 'waiting', barrier })];
    });
    const response = kind === 'direct' ? service.getConversation('agent:planner:project') : null;
    const projected = kind === 'aggregate'
      ? service.listSessions().sessions.find(({ id }) => id === 'agent:planner:project')
      : response ? conversationBody(response).session : null;
    expect(captures).toBe(1);
    expect(projected).toMatchObject({ status: 'waiting' });
  });

  it.each(['aggregate', 'direct'] as const)('keeps a captured active snapshot stable through %s acquisition when the owner transitions afterward', (kind) => {
    const root = project();
    appendConversationBatch({ projectRoot: root }, [call('agent:planner:project')]);
    const owner = { value: snapshot('agent:planner:project', { mode: 'active', barrier: null }) };
    const service = readModel(root, () => {
      const captured = owner.value;
      owner.value = snapshot('agent:planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' } });
      return [captured];
    });
    const response = kind === 'direct' ? service.getConversation('agent:planner:project') : null;
    const status = kind === 'aggregate' ? service.listSessions().sessions[0]!.status : (response ? conversationBody(response).session.status : null);
    expect(status).toBe('active');
  });

  it('rejects every exact barrier identity mismatch, including process and child targets', () => {
    const cases: Array<{ row: AgentMessage; barrier: ExactWaitBarrier; message: string }> = [
      { row: call('agent:planner:project'), barrier: { kind: 'external', sessionId: 'agent:reviewer:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' }, message: 'Wait barrier session' },
      { row: call('agent:planner:project'), barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: 'other', toolCallId: 'call-1', toolName: 'webfetch' }, message: 'exact barrier' },
      { row: call('agent:planner:project'), barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'other', toolName: 'webfetch' }, message: 'exact barrier' },
      { row: call('agent:planner:project'), barrier: { kind: 'external', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'websearch' }, message: 'exact barrier' },
      { row: call('agent:planner:project', 'wait_process', 'call-1', { process_id: 'proc-a' }), barrier: { kind: 'process', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'wait_process', processId: 'proc-b' }, message: 'Waiting process call' },
      { row: call('agent:planner:project', 'webfetch'), barrier: { kind: 'process', sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch', processId: 'proc-a' }, message: 'cannot own a process wait barrier' },
      { row: call('agent:planner:project', 'activate_card', 'call-1', { card_id: 'card-a' }), barrier: { kind: 'child', relationship: { sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'activate_card', childCardId: 'card-b' } }, message: 'Waiting child call' },
      { row: call('agent:planner:project', 'webfetch', 'call-1', { card_id: 'card-a' }), barrier: { kind: 'child', relationship: { sessionId: 'agent:planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch', childCardId: 'card-a' } }, message: 'cannot own a child wait barrier' },
    ];
    for (const testCase of cases) {
      const root = project();
      appendConversationBatch({ projectRoot: root }, [testCase.row]);
      const live = snapshot('agent:planner:project', { mode: 'waiting', barrier: testCase.barrier });
      expect(() => readModel(root, () => [live]).getConversation('agent:planner:project')).toThrow(testCase.message);
    }
  });

  it('rejects inactive or multiple active orphans and a settled waiting declaration', () => {
    const inactiveRoot = project();
    appendConversationBatch({ projectRoot: inactiveRoot }, [call('agent:planner:project')]);
    expect(() => readModel(inactiveRoot, () => []).getConversation('agent:planner:project')).toThrow('undeclared result-absent');

    const activeRoot = project();
    appendConversationBatch({ projectRoot: activeRoot }, [
      call('agent:planner:project'),
      { ...call('agent:planner:project', 'webfetch', 'call-2'), id: '22222222-2222-4222-8222-222222222222:tool-call:call-2', round_id: 'r-assistant-22222222222242228222222222222222', message_index: 1 },
    ]);
    expect(() => readModel(activeRoot, () => [snapshot('agent:planner:project', { mode: 'active', barrier: null })]).getConversation('agent:planner:project')).toThrow('more than one result-absent');

    const waitingRoot = project();
    appendConversationBatch({ projectRoot: waitingRoot }, [call('agent:planner:project'), result('agent:planner:project')]);
    const barrier = { kind: 'external' as const, sessionId: 'agent:planner:project' as const, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    expect(() => readModel(waitingRoot, () => [snapshot('agent:planner:project', { mode: 'waiting', barrier })]).getConversation('agent:planner:project')).toThrow('no unmatched canonical tool call');
  });
});

function providerExchange(sessionId: ConversationSessionId, model: string, completedAt: string, attemptIndex: number) {
  const sourceInputId = `${sessionId}-${model}`;
  return {
    type: 'provider_exchange' as const,
    data: {
      session_id: sessionId,
      source_input_id: sourceInputId,
      attempt_index: attemptIndex,
      timestamp: completedAt,
      payload: {
        contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'test', model,
        source_input_id: sourceInputId, attempt_index: attemptIndex, request_params: {}, started_at: timestamp,
        completed_at: completedAt, status: 'ok' as const, terminal_tool_fired: null, assistant_output_ids: [],
      },
    },
  };
}
