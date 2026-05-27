import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/index.js';
import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
  ChatReadModelService,
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
  it('builds runtime status from disk fallback with live pid', () => {
    updateRuntimeState(root, { status: 'paused', paused: true, current_card_id: 'card-1', last_tick_at: '2026-01-01T00:00:00.000Z' });

    expect(buildRuntimeStatusReadModel({ projectRoot: root })).toEqual(expect.objectContaining({
      runtime: 'paused',
      paused: true,
      currentCardId: 'card-1',
      goalCount: 0,
      lastTickAt: '2026-01-01T00:00:00.000Z',
      pid: process.pid,
    }));
  });

  it('owns card-runs breadcrumb projection outside the agents package', () => {
    const store = new CardStore(root);
    const goal = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', description: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    updateRuntimeState(root, { status: 'running', current_card_id: goal.id, active_card_run: { card_id: goal.id, card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner-1', executor_session_id: null, correction_attempts: 0, started_at: '2026-01-01T00:00:00.000Z', last_turn_at: '2026-01-01T00:00:00.000Z' } });

    const response = buildCardRunsResponse(root);

    expect(response.active_card_run?.card_id).toBe(goal.id);
    expect(response.active_breadcrumb.map((entry) => entry.card_id)).toEqual(['project', goal.id]);
  });

  it('projects operator card lists and card index counts with allowed actions', () => {
    const store = new CardStore(root);
    store.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    const service = new CardsReadModelService(root);

    const state = service.getRuntimeState().body as { cardIndex: { total: number; byStatus: Record<string, number>; byType: Record<string, number> } };
    const list = service.listCards().body as { cards: Array<{ allowedActions?: string[] }> };

    expect(state.cardIndex.total).toBe(2);
    expect(state.cardIndex.byStatus.backlog).toBe(2);
    expect(state.cardIndex.byType.code).toBe(1);
    expect(list.cards.every((card) => Array.isArray(card.allowedActions))).toBe(true);
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

  it('reads canonical analyst messages and debug jsonl projections', () => {
    const messagesDir = join(root, '.saivage', 'agents', 'messages');
    mkdirSync(messagesDir, { recursive: true });
    writeFileSync(join(messagesDir, 'analyst.jsonl'), '{"role":"assistant","content":"hi"}\nnot-json\n');
    const runtimeDir = join(root, '.saivage', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'errors.jsonl'), '{"message":"apiKey=secret"}\n');

    const chat = new ChatReadModelService(root).getMessages('analyst').body as { messages: unknown[] };
    const debug = new DebugReadModelService(root).getErrors() as { errors: unknown[]; total: number };

    expect(chat.messages).toHaveLength(1);
    expect(debug.total).toBe(1);
    expect(JSON.stringify(debug.errors)).not.toContain('secret');
    expect(existsSync(join(root, '.saivage', 'agents', 'messages', 'analyst.jsonl'))).toBe(true);
  });
});
