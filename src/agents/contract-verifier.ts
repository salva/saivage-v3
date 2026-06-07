import type {
  Contract,
  ContractVerifyResult,
} from '../contracts/contract.js';
import type { PersistedToolCall } from '../contracts/persisted-tool-call.js';
import { sanitizeRecoveryMessage } from './invocation-recovery-policy.js';
import { rawProtocolPreview } from './agent-protocol-violation.js';

export interface Obligation {
  code:
    | 'envelope_missing'
    | 'envelope_invalid_json'
    | 'envelope_schema_violation'
    | 'envelope_field_missing'
    | 'envelope_field_invalid'
    | 'envelope_cross_field'
    | 'terminal_args_not_object';
  locator: string;
  description: string;
  expected?: string;
}

export interface ObligationReport {
  contractId: string;
  obligations: Obligation[];
  proposed: Record<string, unknown> | null;
  toolName: string | null;
}

export type DoneArgsParse =
  | { kind: 'ok'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { kind: 'invalid_json'; toolName: string; toolCallId: string; detail: string }
  | { kind: 'not_object'; toolName: string; toolCallId: string; detail: string; rawPreview: string };

export type ContractCheckResult<Envelope> =
  | { kind: 'satisfied'; envelope: Envelope; terminalName: string }
  | { kind: 'violated'; report: ObligationReport };

export interface ContractVerifier {
  parseDoneArgs(toolCallId: string, toolName: string, rawArguments: string): DoneArgsParse;
  check<Envelope, TypedResult>(
    contract: Contract<Envelope, TypedResult>,
    parse: DoneArgsParse,
  ): ContractCheckResult<Envelope>;
  renderRepairMessage(report: ObligationReport): string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function violationToObligation(
  violation: ContractVerifyResult<unknown> extends infer R
    ? R extends { ok: false; violation: infer V }
      ? V
      : never
    : never,
): Obligation {
  if (violation.code === 'terminal_tool_unexpected') {
    return {
      code: 'envelope_field_invalid',
      locator: violation.locator,
      description: violation.message,
    };
  }
  return {
    code: 'envelope_schema_violation',
    locator: violation.locator,
    description: violation.message,
  };
}

export function createContractVerifier(): ContractVerifier {
  return {
    parseDoneArgs(toolCallId, toolName, rawArguments) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArguments);
      } catch (err) {
        return {
          kind: 'invalid_json',
          toolName,
          toolCallId,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (!isPlainObject(parsed)) {
        return {
          kind: 'not_object',
          toolName,
          toolCallId,
          detail: `terminal tool arguments must be a JSON object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
          rawPreview: rawProtocolPreview(rawArguments),
        };
      }
      const args = parsed;
      return { kind: 'ok', toolName, toolCallId, args };
    },
    check(contract, parse) {
      if (parse.kind === 'invalid_json') {
        return {
          kind: 'violated',
          report: {
            contractId: contract.name,
            toolName: parse.toolName,
            proposed: null,
            obligations: [
              {
                code: 'envelope_invalid_json',
                locator: '',
                description: `tool '${parse.toolName}' arguments are not valid JSON: ${parse.detail}`,
              },
            ],
          },
        };
      }
      if (parse.kind === 'not_object') {
        return {
          kind: 'violated',
          report: {
            contractId: contract.name,
            toolName: parse.toolName,
            proposed: null,
            obligations: [
              {
                code: 'terminal_args_not_object',
                locator: '',
                description: `${parse.detail}; raw_preview=${parse.rawPreview}`,
              },
            ],
          },
        };
      }
      const call: PersistedToolCall = { id: parse.toolCallId, name: parse.toolName, args: parse.args };
      const verdict = contract.verify(call);
      if (verdict.ok) {
        return { kind: 'satisfied', envelope: verdict.envelope, terminalName: verdict.terminalName };
      }
      return {
        kind: 'violated',
        report: {
          contractId: contract.name,
          toolName: parse.toolName,
          proposed: parse.args,
          obligations: [violationToObligation(verdict.violation)],
        },
      };
    },
    renderRepairMessage(report) {
      const lines: string[] = [];
      lines.push(`Contract '${report.contractId}' rejected your last terminal signal. Address the following obligations and re-emit the terminal tool:`);
      for (const o of report.obligations) {
        const expected = o.expected ? ` (expected: ${o.expected})` : '';
        const locator = o.locator ? ` ${o.locator}` : '';
        lines.push(`- [${o.code}]${locator} ${o.description}${expected}`);
      }
      return sanitizeRecoveryMessage(lines.join('\n'), 2000);
    },
  };
}
