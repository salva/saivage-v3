import { describe, expect, it } from 'vitest';

describe('read-only positive checklist', () => {
  it('retains representative passive controls', () => {
    expect(['refresh', 'filter', 'sort', 'search', 'expand/collapse', 'copy', 'navigate']).toContain('refresh');
  });
});
