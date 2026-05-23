import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { appendNote } from '../../src/cards/notes.js';
import { NotificationCenter } from '../../src/notifications/notification-center.js';
import { createSession } from '../../src/agents/session-persistence.js';

describe('Wave C notification triggers - notes', () => {
  let projectRoot: string;
  let saivageDir: string;
  let center: NotificationCenter;
  let cardId: string;
  let goalId: string;
  let subgoalId: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-wave-c-note-'));
    initProjectTree(projectRoot);
    saivageDir = join(projectRoot, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
    store = new CardStore(projectRoot);
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
    subgoalId = store.create({
      type: 'goal',
      parent: goalId,
      title: 'Subgoal',
      description: 'Subgoal desc',
      status: 'active',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      acceptance: 'Subgoal acceptance',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
      blocks: [],
    }).id;
    cardId = store.create({
      type: 'code',
      parent: subgoalId,
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

  it('directive and escalation notes on a goal notify descendant sessions under that goal', () => {
    const childId = store.create({
      type: 'test',
      parent: subgoalId,
      title: 'Nested test',
      description: 'Nested desc',
      status: 'active',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      acceptance: 'Nested acceptance',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
      blocks: [],
    }).id;
    const executor = createSession(saivageDir, 'executor', goalId, childId);
    const reviewer = createSession(saivageDir, 'reviewer', goalId, childId);

    const directive = appendNote(saivageDir, goalId, { author: 'analyst', kind: 'directive', content: 'Adjust implementation plan' });
    let executorNotifications = center.drainPendingForSession(executor.id);
    let reviewerNotifications = center.drainPendingForSession(reviewer.id);
    expect(executorNotifications).toHaveLength(1);
    expect(reviewerNotifications).toHaveLength(1);
    expect(executorNotifications[0].severity).toBe('warn');
    expect(executorNotifications[0].related_note_id).toBe(directive.id);
    expect(reviewerNotifications[0].severity).toBe('warn');
    center.markDeliveredForSession(executor.id, executorNotifications.map((notification) => notification.id));
    center.markDeliveredForSession(reviewer.id, reviewerNotifications.map((notification) => notification.id));

    const escalation = appendNote(saivageDir, goalId, { author: 'analyst', kind: 'escalation', content: 'Stop work and reassess scope' });
    executorNotifications = center.drainPendingForSession(executor.id);
    reviewerNotifications = center.drainPendingForSession(reviewer.id);
    expect(executorNotifications).toHaveLength(1);
    expect(reviewerNotifications).toHaveLength(1);
    expect(executorNotifications[0].severity).toBe('block');
    expect(executorNotifications[0].related_note_id).toBe(escalation.id);
    expect(reviewerNotifications[0].severity).toBe('block');

    expect(center.listForOperator()).toHaveLength(2);
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
