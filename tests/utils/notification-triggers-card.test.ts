import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';
import { createSession } from '../../src/agents/session-persistence.js';

describe('Wave C notification triggers - card mutations', () => {
  let projectRoot: string;
  let store: CardStore;
  let center: NotificationCenter;
  let goalId: string;
  let codeId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-wave-c-card-'));
    initProjectTree(projectRoot);
    mkdirSync(join(projectRoot, '.saivage', 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(projectRoot, '.saivage', 'agents', 'messages'), { recursive: true });
    store = new CardStore(projectRoot);
    center = new NotificationCenter(projectRoot);

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
    codeId = store.create({
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
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('acceptance mutation sends block notifications to active card and parent-goal sessions plus operator', () => {
    const saivageDir = join(projectRoot, '.saivage');
    const executor = createSession(saivageDir, 'executor', goalId, codeId);
    const planner = createSession(saivageDir, 'planner', goalId, null);
    createSession(saivageDir, 'reviewer', 'project', null);

    store.mutateCard(codeId, { acceptance: 'Updated sk-secret acceptance' }, { actor: 'analyst', surface: 'web-chat', reason: 'tighten criteria' });

    const executorNotifications = center.drainPendingForSession(executor.id);
    const plannerNotifications = center.drainPendingForSession(planner.id);
    expect(executorNotifications).toHaveLength(1);
    expect(plannerNotifications).toHaveLength(1);
    expect(executorNotifications[0].kind).toBe('card_changed');
    expect(executorNotifications[0].severity).toBe('block');
    expect(executorNotifications[0].related_card_id).toBe(codeId);
    expect(executorNotifications[0].related_version_seq).toBe(2);
    expect(executorNotifications[0].payload_summary).toContain(`Card ${codeId} updated`);
    expect(executorNotifications[0].payload_summary).not.toContain('sk-secret');

    const operatorNotifications = center.listForOperator();
    expect(operatorNotifications).toHaveLength(1);
    expect(operatorNotifications[0].kind).toBe('card_changed');
    expect(operatorNotifications[0].severity).toBe('block');
  });

  it('non-blocking tracked mutation sends warn severity', () => {
    const saivageDir = join(projectRoot, '.saivage');
    const executor = createSession(saivageDir, 'executor', goalId, codeId);

    store.mutateCard(codeId, { priority: 5 }, { actor: 'analyst', surface: 'web-chat', reason: 'raise priority' });

    const notifications = center.drainPendingForSession(executor.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].severity).toBe('warn');
    expect(center.listForOperator()).toHaveLength(1);
  });
});
