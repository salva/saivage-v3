import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { appendNote } from '../../src/utils/notes.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';
import { createSession } from '../../src/agents/session-persistence.js';

describe('Wave C notification triggers - notes', () => {
  let projectRoot: string;
  let saivageDir: string;
  let center: NotificationCenter;
  let cardId: string;
  let goalId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-wave-c-note-'));
    initProjectTree(projectRoot);
    saivageDir = join(projectRoot, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
    const store = new CardStore(projectRoot);
    goalId = store.create({
      type: 'goal',
      parent: 'project',
      title: 'Goal',
      description: 'Goal desc',
      status: 'active',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      acceptance: 'Goal acceptance',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
      blocks: [],
    }).id;
    cardId = store.create({
      type: 'code',
      parent: goalId,
      title: 'Code',
      description: 'Code desc',
      status: 'active',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      acceptance: 'Code acceptance',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
      blocks: [],
    }).id;
    center = new NotificationCenter(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('directive note enqueues warn to active sessions and operator with redacted summary', () => {
    const executor = createSession(saivageDir, 'executor', goalId, cardId);
    const planner = createSession(saivageDir, 'planner', goalId, null);

    const note = appendNote(saivageDir, cardId, { author: 'analyst', kind: 'directive', content: 'Investigate apiKey="123" before retrying' });

    const executorNotifications = center.drainPendingForSession(executor.id);
    const plannerNotifications = center.drainPendingForSession(planner.id);
    expect(executorNotifications).toHaveLength(1);
    expect(plannerNotifications).toHaveLength(1);
    expect(executorNotifications[0].severity).toBe('warn');
    expect(executorNotifications[0].kind).toBe('note_added');
    expect(executorNotifications[0].related_note_id).toBe(note.id);
    expect(executorNotifications[0].payload_summary).not.toContain('123');
    expect(center.listForOperator()).toHaveLength(1);
    expect(center.listForOperator()[0].severity).toBe('warn');
  });

  it('escalation note enqueues block severity', () => {
    const executor = createSession(saivageDir, 'executor', goalId, cardId);

    appendNote(saivageDir, cardId, { author: 'analyst', kind: 'escalation', content: 'Stop and reassess' });

    const notifications = center.drainPendingForSession(executor.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].severity).toBe('block');
    expect(center.listForOperator()[0].severity).toBe('block');
  });

  it('comment note is operator-only info', () => {
    const executor = createSession(saivageDir, 'executor', goalId, cardId);

    appendNote(saivageDir, cardId, { author: 'analyst', kind: 'comment', content: 'FYI only' });

    expect(center.drainPendingForSession(executor.id)).toEqual([]);
    const operatorNotifications = center.listForOperator();
    expect(operatorNotifications).toHaveLength(1);
    expect(operatorNotifications[0].severity).toBe('info');
  });
});
