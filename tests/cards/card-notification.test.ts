import { describe, expect, it } from '@jest/globals';
import { createCardNotification } from '../../src/cards/store-api.js';

describe('cards-owned notification construction', () => {
  it('creates a fresh backend identity and time with exact source and body', () => {
    const before = Date.now();
    const first = createCardNotification('operator', 'Recheck current facts.');
    const second = createCardNotification('operator', 'Recheck current facts.');
    expect(first).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
      content: 'Recheck current facts.',
      created_at: expect.any(String),
      source: 'operator',
    });
    expect(Date.parse(first.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(first.created_at)).toBeLessThanOrEqual(Date.now());
    expect(second.id).not.toBe(first.id);
  });
});
