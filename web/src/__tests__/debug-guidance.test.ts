import { describe, expect, it } from 'vitest';
import source from '../views/DebugView.vue?raw';

describe('Debug operator guidance', () => {
  it('identifies Debug Errors as durable failure evidence without assigning errors to Dashboard', () => {
    expect(source).toContain('Debug &gt; Errors is the durable error surface');
    expect(source).toMatch(
      /durable command, precondition, activation, and\s+actionable-error evidence/,
    );
    expect(source).not.toMatch(/Dashboard (?:owns|for) command errors/);
    expect(source).not.toContain('Dashboard with next-action guidance');
  });
});
