import type { AgentMessage } from '../../../schemas/index.js';
import type {
  SourceRound,
  ValidatedConversation,
} from '../../../contracts/conversation-validation.js';
import { isConversationBudgetVisible } from '../conversation-session.js';
import { projectedCanonicalRowContent } from '../context/composition-projector.js';

export type SubRoundKind = 'repair';

export type ClassifiedMessage = {
  message: AgentMessage;
  estimated_tokens: number;
};

export type ClassifiedSubRound = {
  id: string;
  kind: SubRoundKind;
  anchor_message_id: string;
  rows: ClassifiedMessage[];
};

export type ClassifiedRound = {
  round_id: string;
  activation_marker: ClassifiedMessage | null;
  rows: ClassifiedMessage[];
  sub_rounds: ClassifiedSubRound[];
  estimated_tokens: number;
};

export type ClassifiedConversation = {
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
  return Math.max(1, Math.ceil((content.length + structural.length) / 4));
}

function buildRound(
  source: SourceRound,
  byId: ReadonlyMap<string, ClassifiedMessage>,
): ClassifiedRound {
  const marker = source.activation.source === 'row' ? byId.get(source.activation.message.id)! : null;
  const rows = source.rows.map((row) => byId.get(row.id)!);
  if (rows.length === 0) throw new Error('Cannot classify an empty activation round.');
  const roundId = source.label;
  return {
    round_id: roundId,
    activation_marker: marker,
    rows,
    sub_rounds: source.segments
      .filter((segment) => segment.kind === 'repair').map((segment) => {
    const subRows = segment.rows.map((row) => byId.get(row.id)!);
    const anchor = subRows[0]!;
    return {
      id: `${roundId}#${anchor.message.id}`,
          kind: 'repair' as const,
          anchor_message_id: anchor.message.id,
          rows: subRows,
        };
      }),
    estimated_tokens: rows.reduce((sum, row) => sum + row.estimated_tokens, 0),
  };
}
