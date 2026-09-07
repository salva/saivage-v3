import type { AgentMessage } from '../../../schemas/index.js';
import type {
  SourceRound,
  ValidatedConversation,
} from '../../../contracts/conversation-validation.js';
import { isConversationBudgetVisible } from '../conversation-session.js';
import { projectedCanonicalRowContent } from '../context/composition-projector.js';
import { estimateUtf8Tokens } from './token-estimator.js';

type ClassifiedMessage = {
  message: AgentMessage;
  estimated_tokens: number;
};

export type ClassifiedRound = {
  round_id: string;
  state: 'closed' | 'open';
  rows: ClassifiedMessage[];
  estimated_tokens: number;
};

type ClassifiedConversation = {
  preamble: ClassifiedMessage[];
  rounds: ClassifiedRound[];
};

export function classifyConversationRounds(
  conversation: ValidatedConversation,
): ClassifiedConversation {
  const classifiedRows = conversation.sourceRows.map((message) => ({ message, estimated_tokens: estimateMessageTokens(message),
  }));
  const byId = new Map(classifiedRows.map((row) => [row.message.id, row]));
  const preamble = conversation.preamble.map((row) => byId.get(row.id)!);
  const rounds = conversation.rounds.map((round) => buildRound(round, byId));

  return { preamble, rounds };
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!isConversationBudgetVisible(message)) return 0;
  const content = projectedCanonicalRowContent(message);
  const structural = [message.role, message.kind, message.tool, message.tool_call_id, message.round_id,
  ].filter(Boolean).join(' ');
  return Math.max(1, estimateUtf8Tokens(content + structural));
}

function buildRound(
  source: SourceRound,
  byId: ReadonlyMap<string, ClassifiedMessage>,
): ClassifiedRound {
  const rows = source.rows.map((row) => byId.get(row.id)!);
  return {
    round_id: source.label,
    state: source.state,
    rows,
    estimated_tokens: rows.reduce((sum, row) => sum + row.estimated_tokens, 0),
  };
}
