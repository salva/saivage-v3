import { cardStatusValues } from '@saivage/schemas';
import { describe, expect, it } from 'vitest';

import { deriveCardLifecycleSummary } from '../stores/cards';
import { cardStatusTone, statusForCard } from '../utils/status';
import treeSource from '../components/cards/CardsTreeView.vue?raw';
import { cardView, hierarchyView } from './card-view-fixtures';

describe('stopped card status projection', () => {
  it('keeps the tone table exhaustive and distinguishes stopped from cancelled', () => {
    expect(Object.keys(cardStatusTone).sort()).toEqual([...cardStatusValues].sort());
    expect(statusForCard('stopped')).toEqual({ label: 'stopped', tone: 'success', indicator: 'ringed-dot', description: undefined });
    expect(statusForCard('cancelled')).toEqual({ label: 'cancelled', tone: 'neutral', description: undefined });
    expect(treeSource).toContain('.state-ball.card-status-stopped');
    expect(treeSource).toContain('var(--card-status-stopped-ring)');
  });

  it('projects stopped as inactive, nonblocking, and separately counted', () => {
    const summary = deriveCardLifecycleSummary(cardView('card-a', { lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } }), [
      hierarchyView('card-a-a', { status: 'stopped' }),
      hierarchyView('card-a-b', { status: 'running' }),
      hierarchyView('card-a-c', { status: 'done' }),
    ]);

    expect(summary).toMatchObject({ status: 'stopped', phase: 'stopped', completionState: 'stopped', hasActiveChildren: true, hasBlockingChildren: false });
    expect(summary).not.toHaveProperty('terminal');
    expect(summary.childCounts).toEqual({ backlog: 0, running: 1, blocked: 0, changed: 0, stopped: 1, done: 1, failed: 0, cancelled: 0 });
  });
});
