import type { PersistedToolCall } from './persisted-tool-call.js';
import type {
  ContractTerminalDescriptor,
  ContractVerifyResult,
} from './contract.js';

export function verifyAgainstTerminals<Envelope>(
  call: PersistedToolCall,
  terminals: readonly ContractTerminalDescriptor[],
  contractName: string,
): ContractVerifyResult<Envelope> {
  const terminal = terminals.find((t) => t.name === call.name);
  if (!terminal) {
    const expected = terminals.map((t) => t.name).join(', ');
    return {
      ok: false,
      violation: {
        code: 'terminal_tool_unexpected',
        message: `contract '${contractName}' got terminal call '${call.name}', expected one of [${expected}]`,
        locator: `contract:${contractName}`,
      },
    };
  }
  const parsed = terminal.schema.safeParse(call.args);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      violation: {
        code: 'terminal_tool_invalid_envelope',
        message: `contract '${contractName}' terminal '${call.name}' failed schema: ${summary}`,
        locator: `contract:${contractName}/terminal:${terminal.name}`,
      },
    };
  }
  return { ok: true, terminalName: terminal.name, envelope: parsed.data as Envelope };
}
