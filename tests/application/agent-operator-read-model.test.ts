import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService, captureExecutingLlmSnapshotMap, projectAgentConversation } from '../../src/application/read-models/agent-operator-read-model.js';
import { CardService } from '../../src/cards/card-service.js';
import { publishConversationFirstBatch } from '../../src/persistence/conversation-file.js';
import type { ExactWaitBarrier, ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';

const timestamp = '2026-07-18T00:00:00.000Z';
const inputId = '11111111-1111-4111-8111-111111111111';
let roots: string[] = [];

afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function project() { const root = mkdtempSync(join(tmpdir(), 'saivage-agent-read-')); roots.push(root); initProjectTree(root); return root; }
function text(session_id: ConversationSessionId): AgentMessage { return { id: `${session_id}:text`, session_id, role: 'user', kind: 'text', content: 'hello', round_id: `r-user-${inputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp }; }
function call(session_id: ConversationSessionId, tool = 'webfetch', toolCallId = 'call-1', args: Record<string, unknown> = { url: 'https://example.com' }): AgentMessage { return { id: `${inputId}:tool-call:${toolCallId}`, session_id, role: 'assistant', kind: 'tool_call', tool, tool_call_id: toolCallId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }), round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp }; }
function snapshot(sessionId: ConversationSessionId, activity: ExecutingLlmSnapshot['activity']): ExecutingLlmSnapshot { const [role, card] = sessionId.split(':'); return { sessionId, agentId: sessionId, role: role as 'planner' | 'executor' | 'reviewer' | 'analyst', cardId: role === 'analyst' ? null : card!, activity }; }
function conversationBody(result: ReturnType<AgentOperatorReadModelService['getConversation']>) { if (result.statusCode === 400 || result.statusCode === 404) throw new Error(result.body.error); return result.body; }
function detailBody(result: ReturnType<AgentOperatorReadModelService['getSession']>) { if (result.statusCode === 400 || result.statusCode === 404) throw new Error(result.body.error); return result.body; }

describe('AgentOperatorReadModelService snapshot-first exact projection', () => {
  it.each(['detail', 'conversation'] as const)('maps only ENOENT to the existing direct %s 404', (operation) => {
    const invoke = (root: string) => {
      const service = new AgentOperatorReadModelService(root, () => []);
      return operation === 'detail' ? service.getSession('planner:project') : service.getConversation('planner:project');
    };

    const missingRoot = project();
    expect(invoke(missingRoot)).toEqual({ statusCode: 404, body: { error: 'Agent session not found' } });

    const malformedRoot = project();
    writeFileSync(conversationFile(malformedRoot, 'planner:project'), '{malformed}\n');
    expect(() => invoke(malformedRoot)).toThrow(/malformed/);

    const symlinkRoot = project();
    const referent = join(symlinkRoot, 'conversation-referent.jsonl');
    writeFileSync(referent, 'referent-original');
    symlinkSync(referent, conversationFile(symlinkRoot, 'planner:project'));
    expect(() => invoke(symlinkRoot)).toThrow();
    expect(readFileSync(referent, 'utf8')).toBe('referent-original');

    const directoryRoot = project();
    mkdirSync(conversationFile(directoryRoot, 'planner:project'));
    expect(() => invoke(directoryRoot)).toThrow();

    const fifoRoot = project();
    expect(spawnSync('mkfifo', [conversationFile(fifoRoot, 'planner:project')]).status).toBe(0);
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
    publishConversationFirstBatch({ projectRoot: root }, [call('planner:project')]);
    const barrier = { kind: 'external' as const, sessionId: 'planner:project' as const, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    const owner = { value: snapshot('planner:project', { mode: 'waiting', barrier }) };
    const service = new AgentOperatorReadModelService(root, () => [owner.value]);
    const listed = service.listSessions().sessions.find((row) => row.id === 'planner:project')!;
    const detail = detailBody(service.getSession('planner:project')).session;
    const conversation = conversationBody(service.getConversation('planner:project'));
    expect(listed.status).toBe('waiting');
    expect(detail.status).toBe('waiting');
    expect(conversation.session).toEqual(listed);
    expect(conversation.activity_status).toEqual({ status: 'waiting', pending_calls: [{ id: 'call-1', tool: 'webfetch', started_at: timestamp }] });
    owner.value = snapshot('planner:project', { mode: 'active', barrier: null });
    expect(conversationBody(service.getConversation('planner:project'))).toMatchObject({ session: { status: 'active' }, activity_status: { status: 'active', pending_calls: [] } });
    owner.value = undefined as never;
    expect(conversationBody(new AgentOperatorReadModelService(root, () => []).getConversation('planner:project'))).toMatchObject({ session: { status: 'inactive' }, activity_status: { status: 'inactive', pending_calls: [] } });
  });

  it('omits tombstoned inventory while exact direct history remains inactive', () => {
    const root = project();
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const sessionId = `executor:${child.id}` as ConversationSessionId;
    publishConversationFirstBatch({ projectRoot: root }, [text(sessionId)]);
    const service = new AgentOperatorReadModelService(root, () => []);
    expect(service.listSessions().sessions.map(({ id }) => id)).toContain(sessionId);
    cards.deleteSubtrees([child.id], () => true);
    expect(service.listSessions().sessions.map(({ id }) => id)).not.toContain(sessionId);
    expect(conversationBody(service.getConversation(sessionId))).toMatchObject({ session: { id: sessionId, status: 'inactive' }, activity_status: { status: 'inactive', pending_calls: [] } });
  });

  it('enforces aggregate completeness without applying it to unrelated direct reads', () => {
    const root = project();
    publishConversationFirstBatch({ projectRoot: root }, [text('planner:project')]);
    const missing = snapshot('executor:card-a', { mode: 'active', barrier: null });
    const service = new AgentOperatorReadModelService(root, () => [missing]);
    expect(() => service.listSessions()).toThrow("Executing agent snapshot 'executor:card-a' has no aggregate conversation row");
    expect(conversationBody(service.getConversation('planner:project'))).toMatchObject({ session: { status: 'inactive' } });
  });

  it('returns every conversation from a large active-card aggregate in stable ID order', () => {
    const root = project();
    const cards = new CardService(root);
    const sessionIds: ConversationSessionId[] = [];
    for (let index = 0; index < 30; index += 1) {
      const child = cards.create({ type: 'code', parent: 'project', title: `child-${index}`, brief: 'brief', tags: [], priority: index, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const sessionId = `executor:${child.id}` as ConversationSessionId;
      sessionIds.push(sessionId);
      publishConversationFirstBatch({ projectRoot: root }, [text(sessionId)]);
    }
    expect(new AgentOperatorReadModelService(root, () => []).listSessions().sessions.map(({ id }) => id)).toEqual([...sessionIds].sort());
  });

  it('freezes one captured activity and rejects exact call identity mismatches', () => {
    const root = project();
    publishConversationFirstBatch({ projectRoot: root }, [call('planner:project')]);
    const owner = { value: snapshot('planner:project', { mode: 'active', barrier: null }) };
    const frozen = captureExecutingLlmSnapshotMap([owner.value]);
    expect(Object.isFrozen(frozen.get('planner:project'))).toBe(true);
    expect(Object.isFrozen(frozen.get('planner:project')!.activity)).toBe(true);
    owner.value = snapshot('planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'wrong', toolName: 'webfetch' } });
    expect(projectAgentConversation({ sessionId: 'planner:project', messages: [call('planner:project')], model: null, snapshot: frozen.get('planner:project') })).toMatchObject({ activity_status: { status: 'active' } });
    const mismatch = snapshot('planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'wrong', toolName: 'webfetch' } });
    expect(() => new AgentOperatorReadModelService(root, () => [mismatch]).getConversation('planner:project')).toThrow('does not match its exact barrier');
    expect((frozen as unknown as { set?: unknown }).set).toBeUndefined();
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it.each(['aggregate', 'direct'] as const)('captures waiting before %s row acquisition and finds the already-published call', (kind) => {
    const root = project();
    const barrier = { kind: 'external' as const, sessionId: 'planner:project' as const, sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' };
    let captures = 0;
    const service = new AgentOperatorReadModelService(root, () => {
      captures += 1;
      publishConversationFirstBatch({ projectRoot: root }, [call('planner:project')]);
      return [snapshot('planner:project', { mode: 'waiting', barrier })];
    });
    const response = kind === 'direct' ? service.getConversation('planner:project') : null;
    const projected = kind === 'aggregate'
      ? service.listSessions().sessions.find(({ id }) => id === 'planner:project')
      : response ? conversationBody(response).session : null;
    expect(captures).toBe(1);
    expect(projected).toMatchObject({ status: 'waiting' });
  });

  it.each(['aggregate', 'direct'] as const)('keeps a captured active snapshot stable through %s acquisition when the owner transitions afterward', (kind) => {
    const root = project();
    publishConversationFirstBatch({ projectRoot: root }, [call('planner:project')]);
    const owner = { value: snapshot('planner:project', { mode: 'active', barrier: null }) };
    const service = new AgentOperatorReadModelService(root, () => {
      const captured = owner.value;
      owner.value = snapshot('planner:project', { mode: 'waiting', barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' } });
      return [captured];
    });
    const response = kind === 'direct' ? service.getConversation('planner:project') : null;
    const status = kind === 'aggregate' ? service.listSessions().sessions[0]!.status : (response ? conversationBody(response).session.status : null);
    expect(status).toBe('active');
  });

  it('rejects every exact barrier identity mismatch, including process and child targets', () => {
    const cases: Array<{ row: AgentMessage; barrier: ExactWaitBarrier; message: string }> = [
      { row: call('planner:project'), barrier: { kind: 'external', sessionId: 'reviewer:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' }, message: 'Wait barrier session' },
      { row: call('planner:project'), barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: 'other', toolCallId: 'call-1', toolName: 'webfetch' }, message: 'exact barrier' },
      { row: call('planner:project'), barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'other', toolName: 'webfetch' }, message: 'exact barrier' },
      { row: call('planner:project'), barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'websearch' }, message: 'exact barrier' },
      { row: call('planner:project', 'wait_process', 'call-1', { process_id: 'proc-a' }), barrier: { kind: 'process', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'wait_process', processId: 'proc-b' }, message: 'Waiting process call' },
      { row: call('planner:project', 'webfetch'), barrier: { kind: 'process', sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch', processId: 'proc-a' }, message: 'cannot own a process wait barrier' },
      { row: call('planner:project', 'activate_card', 'call-1', { card_id: 'card-a' }), barrier: { kind: 'child', relationship: { sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'activate_card', childCardId: 'card-b' } }, message: 'Waiting child call' },
      { row: call('planner:project', 'webfetch', 'call-1', { card_id: 'card-a' }), barrier: { kind: 'child', relationship: { sessionId: 'planner:project', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch', childCardId: 'card-a' } }, message: 'cannot own a child wait barrier' },
    ];
    for (const testCase of cases) {
      const root = project();
      publishConversationFirstBatch({ projectRoot: root }, [testCase.row]);
      const live = snapshot('planner:project', { mode: 'waiting', barrier: testCase.barrier });
      expect(() => new AgentOperatorReadModelService(root, () => [live]).getConversation('planner:project')).toThrow(testCase.message);
    }
  });
});
