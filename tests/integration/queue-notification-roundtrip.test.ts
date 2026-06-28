import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { loadConfig } from '../../src/agents/config-schema.js';
import { createSession } from '../../src/agents/session-persistence.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { getProjectNotificationCenter } from '../../src/notifications/notification-delivery.js';
import { queueNotification } from '../../src/notifications/notification-triggers.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string }): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & { id?: string } {
  return { parent: 'project', depth: 1, description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', assigned_to: null, depends_on: [], related: [], acceptance: '', lifecycle: ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']), metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
}

describe('queue notification roundtrip', () => {
  let projectRoot: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-queue-roundtrip-'));
    initProjectTree(projectRoot);
    store = new CardStore(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('injects queued notification kind and body into the receiving session transcript exactly once and leaves no legacy on-disk artifacts', () => {
    const goal = store.create(makeCard({ id: 'goal-1', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, depth: 2, status: 'running' }));
    createSession(join(projectRoot, '.saivage'), 'executor', goal.id, child.id, undefined, 'executor-session');
    const adapter = new AgentAdapter({ projectRoot, saivageDir: join(projectRoot, '.saivage'), config: loadConfig(projectRoot).config, cardStore: store });

    queueNotification(projectRoot, { kind: 'session', sessionId: 'executor-session' }, 'card_changed', 'refresh the implementation plan', { actor: 'planner', surface: 'runtime' });

    const firstDrain = (adapter as unknown as { buildModelMessages(sessionId: string): Array<{ content: string }> }).buildModelMessages('executor-session');
    const transcript = firstDrain.map((message) => message.content).join('\n');
    expect(transcript).toContain('[card_changed] refresh the implementation plan');
    expect(transcript.match(/\[card_changed\] refresh the implementation plan/g)).toHaveLength(1);

    const secondDrain = (adapter as unknown as { buildModelMessages(sessionId: string): Array<{ content: string }> }).buildModelMessages('executor-session');
    expect(secondDrain.map((message) => message.content).join('\n')).not.toContain('refresh the implementation plan');
    expect(getProjectNotificationCenter(projectRoot).drainPendingForSession('executor-session')).toEqual([]);

    expect(existsSync(join(projectRoot, '.saivage', 'runtime', 'notifications', 'by-session'))).toBe(false);
    expect(existsSync(join(projectRoot, '.saivage', 'runtime', 'notifications', 'operator.jsonl'))).toBe(false);
    expect(existsSync(join(projectRoot, '.saivage', 'notes'))).toBe(false);
  });
});
