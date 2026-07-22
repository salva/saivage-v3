import { describe, expect, it } from '@jest/globals';

import { allowedOperatorCardActions } from '../../src/permissions/index.js';
import { cardActionSchema, cardStatusValues } from '../../src/schemas/index.js';

describe('operator card action projection', () => {
  it('projects every card status in canonical action order', () => {
    const expected = {
      backlog: ['card.start', 'card.cancel', 'card.delete'],
      running: ['card.cancel'],
      blocked: ['card.cancel', 'card.delete'],
      changed: ['card.start', 'card.cancel', 'card.delete'],
      stopped: ['card.start', 'card.cancel', 'card.delete'],
      done: ['card.delete'],
      failed: ['card.cancel', 'card.delete'],
      cancelled: ['card.delete'],
    } as const;
    for (const status of cardStatusValues) expect(allowedOperatorCardActions(status)).toEqual(expected[status]);
  });

  it('never projects create, reorder, or removed restart actions', () => {
    for (const status of cardStatusValues) {
      const actions = allowedOperatorCardActions(status);
      expect(actions).not.toContain('card.create');
      expect(actions).not.toContain('card.reorder_child');
      expect(actions).not.toContain('card.restart');
    }
    expect(cardActionSchema.safeParse('card.restart').success).toBe(false);
  });
});
