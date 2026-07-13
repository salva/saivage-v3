import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { testActorSnapshots } from '../helpers/actor-snapshots.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appendProviderExchangeLogEntry } from '../../src/persistence/provider-exchange-log.js';
import { initRuntimeState, runtimeStatePath, updateRuntimeState } from '../../src/runtime/state.js';

import { appendConversationMessage, buildContextTextMessage } from '../../src/runtime/actors/index.js';
import {
  AgentOperatorReadModelService,
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
  DebugReadModelService,
  WorkspaceFileReadModelService,
} from '../../src/application/read-models/index.js';

let root: string;

function seedProject(): void {
  root = mkdtempSync(join(tmpdir(), 'saivage-read-models-'));
  initProjectTree(root);
  initRuntimeState(root);
}

beforeEach(() => {
  seedProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('application read models', () => {
  it('requires a runtime API for runtime status', () => {
    expect(() => buildRuntimeStatusReadModel({ projectRoot: root } as never)).toThrow();
  });

  it('builds runtime status from the live runtime API', () => {
    const actorRuntime = { pauseMode: 'paused' as const, activeWork: 'model_invocation' as const, cards: [{ cardId: 'live-card', actorState: 'running' as const }], agents: [{ agentId: 'planner:live-card', role: 'planner' as const, cardId: 'live-card', phase: 'calling_provider' as const }], diagnostics: [], recovery: null };

    expect(buildRuntimeStatusReadModel({
      projectRoot: root,
      runtimeApi: {
        getStatus: () => ({ status: 'paused' as const, currentCardId: 'live-card', goalCount: 1, lastTickAt: '2026-01-01T00:00:00.000Z' }),
        getActorRuntimeReadModel: () => actorRuntime,
      },
    })).toEqual(expect.objectContaining({
      runtime: 'paused',
      currentCardId: 'live-card',
      goalCount: 1,
      lastTickAt: '2026-01-01T00:00:00.000Z',
      pid: process.pid,
      actorRuntime,
    }));
  });

  it('runtime status uses live actor read model instead of snapshot files', () => {
    testActorSnapshots(root).save({ actor_id: 'card:disk-card', actor_kind: 'card', state_value: 'failed', context: {}, updated_at: new Date().toISOString() });
    const liveActorRuntime = { pauseMode: 'running' as const, activeWork: 'none' as const, cards: [{ cardId: 'live-card', actorState: 'running' as const }], agents: [], diagnostics: [], recovery: null };

    const model = buildRuntimeStatusReadModel({
      projectRoot: root,
      runtimeApi: {
        getStatus: () => ({ status: 'running' as const, currentCardId: 'live-card', goalCount: 1, lastTickAt: null }),
        getActorRuntimeReadModel: () => liveActorRuntime,
      },
    });

    expect(model.actorRuntime.cards).toEqual([{ cardId: 'live-card', actorState: 'running' }]);
  });

  it('owns card-runs breadcrumb projection outside the agents package', () => {
    const store = new CardStore(root);
    const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', brief: 'Goal brief.', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    updateRuntimeState(root, { status: 'running', active_card_run: { card_id: goal.id, card_type: 'goal', ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner-1', executor_session_id: null, correction_attempts: 0, started_at: '2026-01-01T00:00:00.000Z', last_turn_at: '2026-01-01T00:00:00.000Z' } });

    const response = buildCardRunsResponse(root, store);

    expect(response.active_card_run?.card_id).toBe(goal.id);
    expect(response.active_breadcrumb.map((entry) => entry.card_id)).toEqual(['project', goal.id]);
  });

  it('projects operator card lists and card index counts with allowed actions', () => {
    const store = new CardStore(root);
    store.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', brief: 'Code brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const service = new CardsReadModelService(root, store);

    const state = service.getRuntimeState().body as { cardIndex: { total: number; byStatus: Record<string, number>; byType: Record<string, number> } };
    const list = service.listCards().body as { cards: Array<{ allowedActions?: string[] }> };

    expect(state.cardIndex.total).toBe(2);
    expect(state.cardIndex.byStatus.backlog).toBe(2);
    expect(state.cardIndex.byType.code).toBe(1);
    expect(list.cards.every((card) => Array.isArray(card.allowedActions))).toBe(true);
  });

  it('returns null runtime state when the persisted runtime-state projection is absent', () => {
    rmSync(runtimeStatePath(root), { force: true });
    const store = new CardStore(root);
    const service = new CardsReadModelService(root, store);

    const state = service.getRuntimeState().body as { runtime: unknown; cardIndex: { total: number } };

    expect(state.runtime).toBeNull();
    expect(state.cardIndex.total).toBe(1);
  });

  it('exposes canonical lifecycle in operator read models', () => {
    const store = new CardStore(root);
    store.invalidate();
    const lifecycle = {
      status: 'done',
      result: { kind: 'done' as const, summary: 'complete' },
      error: null,
      completed_at: '2026-01-01T00:00:00.000Z',
    } as const;
    store.commitTerminalLifecyclePatch('project', { status: 'done', lifecycle });
    const service = new CardsReadModelService(root, store);

    const list = service.listCards().body as { cards: Array<{ id: string; status: string; lifecycle: unknown }> };
    const project = list.cards.find((card) => card.id === 'project');
    const detail = service.getCard('project').body as { card: { status: string; lifecycle: unknown } };

    expect(project).toEqual(expect.objectContaining({ status: 'done', lifecycle }));
    expect(detail.card.lifecycle).toEqual(project?.lifecycle);
  });

  it('projects dynamic card display paths without changing stable ids', () => {
    const store = new CardStore(root);
    const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', brief: 'Goal brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const first = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'First', brief: 'First brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const second = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'Second', brief: 'Second brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const service = new CardsReadModelService(root, store);

    const projectDetail = service.getCard('project').body as { card: { display_path: string | null } };
    const goalDetail = service.getCard(goal.id).body as { card: { id: string; display_path: string | null }; children: Array<{ id: string; display_path: string | null }> };

    expect(projectDetail.card.display_path).toBeNull();
    expect(goalDetail.card).toEqual(expect.objectContaining({ id: goal.id, display_path: '1' }));
    expect(goalDetail.children.map((child) => [child.id, child.display_path])).toEqual([[first.id, '1.1'], [second.id, '1.2']]);

    expect(store.reorderChildren(goal.id, [second.id, first.id], { actor: 'analyst', surface: 'web-chat', reason: 'test reorder' })).toEqual({ ok: true, changed: 2 });
    const reordered = service.getCard(goal.id).body as { children: Array<{ id: string; display_path: string | null }> };

    expect(reordered.children.map((child) => child.id).sort()).toEqual([first.id, second.id].sort());
    expect(reordered.children.map((child) => [child.id, child.display_path])).toEqual([[second.id, '1.1'], [first.id, '1.2']]);
  });

  it('keeps workspace file safety and binary decisions in the file read model', () => {
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, 'reports', 'ok.txt'), 'hello');
    writeFileSync(join(root, 'reports', 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    const service = new WorkspaceFileReadModelService(root);

    expect((service.listFiles('reports').body as { files: Array<{ name: string }> }).files.map((file) => file.name)).toContain('ok.txt');
    expect(service.readFileContent('../outside').statusCode).toBe(403);
    expect(service.readFileContent('reports/binary.bin').statusCode).toBe(415);
  });

  it('reads canonical analyst segment entries and debug jsonl projections', () => {
    appendConversationMessage(root, { ...buildContextTextMessage('analyst:global', 'system', 'system prompt'), id: 'msg-1', kind: 'system_prompt', timestamp: '2026-01-01T00:00:00.000Z' });
    appendConversationMessage(root, { ...buildContextTextMessage('analyst:global', 'user', 'hi'), id: 'msg-2', timestamp: '2026-01-01T00:00:01.000Z' });
    appendAppLogEntry(root, 'error', { id: 'err-1', kind: 'error', timestamp: '2026-01-01T00:00:02.000Z', message: 'apiKey=secret' }, '2026-01-01T00:00:02.000Z');

    const chat = new AgentOperatorReadModelService(root).getConversation('analyst:global').body as { entries: Array<{ kind: string }> };
    const debug = new DebugReadModelService(root, new CardStore(root)).getErrors() as { errors: unknown[]; total: number };

    expect(chat.entries.map((entry) => entry.kind)).toEqual(['system_prompt', 'text']);
    expect(debug.total).toBe(1);
    expect(JSON.stringify(debug.errors)).not.toContain('secret');
    expect(existsSync(join(root, '.saivage', 'agents', 'conversations', encodeURIComponent('analyst:global'), '1.jsonl'))).toBe(true);
  });

  it('reports compacting before generic thinking status', () => {
    appendConversationMessage(root, buildContextTextMessage('planner:project', 'user', 'hello'));
    testActorSnapshots(root).save({ actor_id: 'planner:project', actor_kind: 'llm', state_value: 'calling_provider', context: { compacting: true }, updated_at: '2026-01-01T00:00:00.000Z' });

    const chat = new AgentOperatorReadModelService(root).getConversation('planner:project').body as { activity_status: { status: string } };

    expect(chat.activity_status.status).toBe('compacting');
  });

  it('derives latest session model from app-log provider exchange entries', () => {
    appendConversationMessage(root, buildContextTextMessage('planner:project', 'user', 'hello'));
    appendProviderExchangeLogEntry(root, {
      session_id: 'planner:project',
      source_input_id: 'planner:project:1',
      attempt_index: 0,
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        contract_id: 'planner.v1',
        contract_name: 'planner',
        transport: 'generic',
        provider: 'test-provider',
        model: 'app-log-model',
        source_input_id: 'planner:project:1',
        attempt_index: 0,
        request_params: { temperature: 0 },
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        status: 'ok',
        terminal_tool_fired: null,
        assistant_output_ids: ['planner:project:1:message'],
      },
    });

    const { sessions } = new AgentOperatorReadModelService(root).listSessions();

    expect(sessions.find((session) => session.id === 'planner:project')?.model).toBe('app-log-model');
  });
});
