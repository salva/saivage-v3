import type { ReviewerResult } from './agent-execution.js';
import type {
  Contract,
  ContractTerminalDescriptor,
} from './contract.js';
import {
  ReviewerResultEnvelopeSchema,
  type ReviewerResultEnvelope,
} from './reviewer-envelope.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { describeTerminals } from './describe-terminals.js';
import { verifyAgainstTerminals } from './verify-against-terminals.js';
import { TERMINAL_RESULT_TOOL_NAME } from './result-envelope.js';

const REVIEWER_TERMINAL_DESC =
  'Emit the reviewer result envelope as the final action of this turn.';

export function createReviewerContract(): Contract<ReviewerResultEnvelope, ReviewerResult> {
  const terminal: ContractTerminalDescriptor = {
    name: TERMINAL_RESULT_TOOL_NAME,
    description: REVIEWER_TERMINAL_DESC,
    schema: ReviewerResultEnvelopeSchema,
    toolDefinition: {
      type: 'function',
      function: {
        name: TERMINAL_RESULT_TOOL_NAME,
        description: REVIEWER_TERMINAL_DESC,
        parameters: zodToJsonSchemaMini(ReviewerResultEnvelopeSchema) as unknown as Record<string, unknown>,
      },
    },
  };
  const terminals: readonly ContractTerminalDescriptor[] = [terminal];

  return {
    name: 'reviewer',
    terminals,
    describe() {
      return describeTerminals(terminals);
    },
    isTerminalToolName(name) {
      return name === terminal.name;
    },
    verify(call) {
      return verifyAgainstTerminals<ReviewerResultEnvelope>(call, terminals, 'reviewer');
    },
    project(envelope) {
      return { status: envelope.status, summary: envelope.summary };
    },
  };
}
