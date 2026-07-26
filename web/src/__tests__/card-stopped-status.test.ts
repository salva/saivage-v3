import { cardStatusValues } from '@saivage/schemas';
import { describe, expect, it } from 'vitest';

import { cardStatusTone, statusForCard } from '../utils/status';
import treeSource from '../components/cards/CardsTreeView.vue?raw';

describe('stopped card status projection', () => {
  it('keeps the tone table exhaustive and distinguishes stopped from cancelled', () => {
    expect(Object.keys(cardStatusTone).sort()).toEqual([...cardStatusValues].sort());
    expect(statusForCard('stopped')).toEqual({ label: 'stopped', tone: 'success', indicator: 'ringed-dot', description: undefined });
    expect(statusForCard('cancelled')).toEqual({ label: 'cancelled', tone: 'neutral', description: undefined });
    expect(treeSource).toContain('.state-ball.card-status-stopped');
    expect(treeSource).toContain('var(--card-status-stopped-ring)');
  });
});
