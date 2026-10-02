import { describe, expect, it } from 'vitest';
import source from '../components/debug/OperatorControlPanel.vue?raw';

describe('System operator guidance', () => {
  it('identifies System Errors as durable failure evidence without assigning errors to Cockpit', () => {
    expect(source).toContain('System &gt; Errors is the durable error surface');
    expect(source).toMatch(
      /durable command, precondition, activation, and\s+actionable-error\s+evidence/i,
    );
    expect(source).not.toMatch(/Cockpit (?:owns|for) command errors/);
    expect(source).not.toContain('Cockpit with next-action guidance');
  });
});
