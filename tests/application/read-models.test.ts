import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/store-api.js';
import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
  ChatReadModelService,
  DebugReadModelService,
  WorkspaceFileReadModelService,
} from '../../src/application/read-models/index.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

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
  it('builds runtime status from disk fallback with live pid', () => {
    updateRuntimeState(root, { status: 'paused', paused: true, active_card_run: { card_id: 'card-1', card_type: 'goal', ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:card-1', correction_attempts: 0, started_at: '2026-01-01T00:00:00.000Z', last_turn_at: '2026-01-01T00:00:00.000Z' }, last_tick_at: '2026-01-01T00:00:00.000Z' });

    expect(buildRuntimeStatusReadModel({ projectRoot: root })).toEqual(expect.objectContaining({
      runtime: 'paused',
      paused: true,
      currentCardId: 'card-1',
      goalCount: 0,
      lastTickAt: '2026-01-01T00:00:00.000Z',
      pid: process.pid,
      actorRuntime: { pauseMode: 'unknown', cards: [], agents: [], diagnostics: [], recovery: null },
    }));
  });

  it('owns card-runs breadcrumb projection outside the agents package', () => {
    const store = new CardStore(root);
    const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', description: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    updateRuntimeState(root, { status: 'running', active_card_run: { card_id: goal.id, card_type: 'goal', ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner-1', executor_session_id: null, correction_attempts: 0, started_at: '2026-01-01T00:00:00.000Z', last_turn_at: '2026-01-01T00:00:00.000Z' } });

    const response = buildCardRunsResponse(root, store);

    expect(response.active_card_run?.card_id).toBe(goal.id);
    expect(response.active_breadcrumb.map((entry) => entry.card_id)).toEqual([goal.id]);
  });

  it('projects operator card lists and card index counts with allowed actions', () => {
    const store = new CardStore(root);
    store.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const service = new CardsReadModelService(root, store);

    const state = service.getRuntimeState().body as { cardIndex: { total: number; byStatus: Record<string, number>; byType: Record<string, number> } };
    const list = service.listCards().body as { cards: Array<{ allowedActions?: string[] }> };

    expect(state.cardIndex.total).toBe(1);
    expect(state.cardIndex.byStatus.backlog).toBe(1);
    expect(state.cardIndex.byType.code).toBe(1);
    expect(list.cards.every((card) => Array.isArray(card.allowedActions))).toBe(true);
  });

  it('exposes canonical lifecycle in operator read models', () => {
    const store = new CardStore(root);
    materializeProjectCard(root);
    store.invalidate();
    const lifecycle = {
      status: 'done',
      result: { kind: 'planner_done' as const, summary: 'complete' },
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
    materializeProjectCard(root);
    const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const first = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'First', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const second = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'Second', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
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

  it('reads canonical analyst entries and debug jsonl projections', () => {
    const messagesDir = join(root, '.saivage', 'agents', 'messages');
    mkdirSync(messagesDir, { recursive: true });
    writeFileSync(join(messagesDir, 'analyst.jsonl'), '{"id":"msg-1","session_id":"analyst","role":"assistant","kind":"text","content":"hi","round_id":"r-assistant-00000000000000000000000000000001","message_index":0,"block_index":0,"timestamp":"2026-01-01T00:00:00.000Z"}\n');
    const runtimeDir = join(root, '.saivage', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'errors.jsonl'), '{"message":"apiKey=secret"}\n');

    const chat = new ChatReadModelService(root).getEntries('analyst').body as { entries: unknown[] };
    const debug = new DebugReadModelService(root, new CardStore(root)).getErrors() as { errors: unknown[]; total: number };

    expect(chat.entries).toHaveLength(1);
    expect(debug.total).toBe(1);
    expect(JSON.stringify(debug.errors)).not.toContain('secret');
    expect(existsSync(join(root, '.saivage', 'agents', 'messages', 'analyst.jsonl'))).toBe(true);
  });
});
