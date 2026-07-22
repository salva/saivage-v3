import { cardStatusValues } from '@saivage/schemas';
import { describe, expect, it } from 'vitest';

import { deriveCardLifecycleSummary } from '../stores/cards';
import { cardStatusTone } from '../utils/status';
import treeSource from '../components/cards/CardsTreeView.vue?raw';
import { cardView } from './card-view-fixtures';

describe('stopped card status projection', () => {
  it('keeps the tone table exhaustive and presents stopped neutrally', () => {
    expect(Object.keys(cardStatusTone).sort()).toEqual([...cardStatusValues].sort());
    expect(cardStatusTone.stopped).toBe('neutral');
    expect(treeSource).toContain('.state-ball.card-status-stopped');
  });

  it('projects stopped as inactive, nonblocking, and separately counted', () => {
    const summary = deriveCardLifecycleSummary(cardView('card-a', { lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } }), [
      cardView('card-a-a', { lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } }),
      cardView('card-a-b', { lifecycle: { status: 'running', result: null, error: null, completed_at: null } }),
      cardView('card-a-c', { lifecycle: { status: 'done', result: { kind: 'workflow-result', terminal: 'DONE', agent_name: 'executor', node_id: 'execute', outcome: 'done', summary: 'Done', records: [] }, error: null, completed_at: '2026-01-01T00:00:00.000Z' } }),
    ]);

    expect(summary).toMatchObject({ status: 'stopped', phase: 'stopped', completionState: 'stopped', hasActiveChildren: true, hasBlockingChildren: false });
    expect(summary).not.toHaveProperty('terminal');
    expect(summary.childCounts).toEqual({ backlog: 0, running: 1, blocked: 0, changed: 0, stopped: 1, done: 1, failed: 0, cancelled: 0 });
  });
});
