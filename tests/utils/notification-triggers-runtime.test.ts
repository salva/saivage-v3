import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { initRuntimeState } from '../../src/utils/runtime-state.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../src/utils/runtime-control.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';
import { createSession } from '../../src/agents/session-persistence.js';

describe('Wave C notification triggers - runtime control', () => {
  let projectRoot: string;
  let saivageDir: string;
  let center: NotificationCenter;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-wave-c-runtime-'));
    initProjectTree(projectRoot);
    initRuntimeState(projectRoot);
    saivageDir = join(projectRoot, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
    center = new NotificationCenter(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('pause sends block notifications to all active sessions and operator; resume sends info', () => {
    const executor = createSession(saivageDir, 'executor', 'goal-1', 'code-1');
    const reviewer = createSession(saivageDir, 'reviewer', 'goal-1', 'code-1');

    const paused = pauseRuntimeControl({ projectRoot });
    expect(paused.ok).toBe(true);

    const pausedExecutor = center.drainPendingForSession(executor.id);
    const pausedReviewer = center.drainPendingForSession(reviewer.id);
    expect(pausedExecutor).toHaveLength(1);
    expect(pausedReviewer).toHaveLength(1);
    expect(pausedExecutor[0].severity).toBe('block');
    expect(pausedReviewer[0].severity).toBe('block');
    expect(center.listForOperator()[0]?.severity).toBe('block');

    center.markDeliveredForSession(executor.id, pausedExecutor.map((item) => item.id));
    center.markDeliveredForSession(reviewer.id, pausedReviewer.map((item) => item.id));

    const resumed = resumeRuntimeControl({ projectRoot });
    expect(resumed.ok).toBe(true);

    const executorResume = center.drainPendingForSession(executor.id);
    const reviewerResume = center.drainPendingForSession(reviewer.id);
    expect(executorResume).toHaveLength(1);
    expect(reviewerResume).toHaveLength(1);
    expect(executorResume[0].severity).toBe('info');
    expect(reviewerResume[0].severity).toBe('info');
    expect(center.listForOperator()).toHaveLength(2);
    expect(center.listForOperator()[1].severity).toBe('info');
  });
});
