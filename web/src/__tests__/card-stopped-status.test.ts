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
    const summary = deriveCardLifecycleSummary(cardView('card-a', { status: 'stopped' }), [
      cardView('card-a-a', { status: 'stopped' }),
      cardView('card-a-b', { status: 'running' }),
      cardView('card-a-c', { status: 'done' }),
    ]);

    expect(summary).toMatchObject({ status: 'stopped', phase: 'stopped', completionState: 'stopped', hasActiveChildren: true, hasBlockingChildren: false });
    expect(summary).not.toHaveProperty('terminal');
    expect(summary.childCounts).toEqual({ backlog: 0, running: 1, blocked: 0, changed: 0, stopped: 1, done: 1, failed: 0, cancelled: 0 });
  });
});
