import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import type {
  Contract,
  ContractTerminalDescriptor,
  ContractViolation,
} from '../../src/contracts/contract.js';

describe('contract types — smoke', () => {
  it('Contract is generic in envelope and typed result', () => {
    const schema = z.object({ a: z.string() }).strict();
    type Env = z.infer<typeof schema>;
    type Typed = { value: string };
    const terminal: ContractTerminalDescriptor = {
      name: 'x',
      description: 'd',
      schema,
      toolDefinition: { type: 'function', function: { name: 'x', description: 'd', parameters: {} } },
    };
    const c: Contract<Env, Typed> = {
      name: 'demo',
      terminals: [terminal],
      describe: () => 'x',
      isTerminalToolName: (n) => n === 'x',
      verify: () => ({ ok: false, violation: { code: 'terminal_tool_unexpected', message: 'm', locator: 'l' } }),
      project: (env) => ({ value: env.a }),
    };
    const r = c.verify({ id: '1', name: 'x', args: {} });
    expect(r.ok).toBe(false);
    const v: ContractViolation = { code: 'terminal_tool_invalid_envelope', message: 'm', locator: 'l' };
    expect(v.code).toBe('terminal_tool_invalid_envelope');
  });
});
