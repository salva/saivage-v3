import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { verifyAgainstTerminals } from '../../src/contracts/verify-against-terminals.js';
import type { ContractTerminalDescriptor } from '../../src/contracts/contract.js';

const schema = z.object({ a: z.string() }).strict();
const terminals: readonly ContractTerminalDescriptor[] = [
  {
    name: 't1',
    description: 'd',
    schema,
    toolDefinition: { type: 'function', function: { name: 't1', description: 'd', parameters: {} } },
  },
];

describe('verifyAgainstTerminals', () => {
  it('returns terminal_tool_unexpected when call.name is unknown', () => {
    const r = verifyAgainstTerminals({ id: '1', name: 'other', args: {} }, terminals, 'demo');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_unexpected');
    expect(r.violation.locator).toBe('contract:demo');
    expect(r.violation.message).toContain("'other'");
    expect(r.violation.message).toContain('t1');
  });

  it('returns terminal_tool_invalid_envelope when schema fails', () => {
    const r = verifyAgainstTerminals({ id: '1', name: 't1', args: { a: 42 } }, terminals, 'demo');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation.code).toBe('terminal_tool_invalid_envelope');
    expect(r.violation.locator).toBe('contract:demo/terminal:t1');
  });

  it('returns ok envelope when args match', () => {
    const r = verifyAgainstTerminals<{ a: string }>(
      { id: '1', name: 't1', args: { a: 'hi' } },
      terminals,
      'demo',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terminalName).toBe('t1');
    expect(r.envelope).toEqual({ a: 'hi' });
  });
});
