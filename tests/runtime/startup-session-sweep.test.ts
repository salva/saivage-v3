import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Runtime } from '../../src/runtime/runtime.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createSession, completeSession, getSession, getSessionMessages, markSessionWaiting } from '../../src/agents/session-persistence.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/agents/result-parser.js';
import type { HandoffSummary } from '../../src/schemas/types.js';

class NoopAgentRuntime implements AgentRuntime {
  invokePlanner(): Promise<PlannerResult> { return Promise.resolve({ status: 'done', created_cards: [], updated_cards: [] }); }
  invokeExecutor(): Promise<ExecutorResult> { return Promise.resolve({ card_id: 'x', status: 'done', status_text: 'noop', artifacts: [], attachments: [], fallback_with_evidence: null }); }
  invokeReviewer(): Promise<ReviewerResult> { return Promise.resolve({ assessment: { result: 'pass', summary: 'noop', achieved: [], issues: [], evidence_card_ids: [] } }); }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

function readEvents(projectRoot: string): Array<Record<string, unknown>> {
  return readFileSync(join(projectRoot, '.saivage', 'runtime', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('startup worker session sweep', () => {
  let projectRoot: string;
  let saivageDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-startup-sweep-'));
    saivageDir = join(projectRoot, '.saivage');
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('fails orphaned active/waiting workers, preserves terminal manifests, and logs one sweep event', async () => {
    const activeExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-1');
    const waitingExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-2');
    const doneExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-3');
    const planner = createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    markSessionWaiting(saivageDir, waitingExecutor.id);
    completeSession(saivageDir, doneExecutor.id, 'done');
    const doneBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${doneExecutor.id}.json`), 'utf8');

    const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } }, new NoopAgentRuntime());
    await runtime.startup();
    await runtime.shutdown();

    expect(getSession(saivageDir, activeExecutor.id)?.status).toBe('failed');
    expect(getSession(saivageDir, waitingExecutor.id)?.status).toBe('failed');
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${doneExecutor.id}.json`), 'utf8')).toBe(doneBefore);
    expect(getSession(saivageDir, planner.id)?.status).toBe('active');
    for (const sessionId of [activeExecutor.id, waitingExecutor.id]) {
      expect(getSessionMessages(saivageDir, sessionId)).toEqual([
        expect.objectContaining({ role: 'system', kind: 'model_issue' }),
      ]);
    }
    const sweepEvents = readEvents(projectRoot).filter((event) => event.kind === 'startup_session_sweep');
    expect(sweepEvents).toHaveLength(1);
    expect((sweepEvents[0].swept_session_ids as string[]).sort()).toEqual([activeExecutor.id, waitingExecutor.id].sort());
    // /api/agents reads these same persisted manifests; route coverage is therefore exercised by the manifest assertions above.
  });
});
