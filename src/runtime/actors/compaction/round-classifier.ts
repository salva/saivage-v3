import type { AgentMessage } from '../../../schemas/index.js';
import { classifyConversationSourceRows, classifySourceSegments } from '../../../contracts/conversation-source-classification.js';
import { isConversationBudgetVisible } from '../conversation-session.js';

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
  activation_marker: ClassifiedMessage;
  rows: ClassifiedMessage[];
  sub_rounds: ClassifiedSubRound[];
  estimated_tokens: number;
};

export type ClassifiedConversation = {
  preamble: ClassifiedMessage[];
  rounds: ClassifiedRound[];
};

export function classifyConversationRounds(messages: AgentMessage[]): ClassifiedConversation {
  const sourceRows = messages.filter((message) => message.kind !== 'context_compaction');
  const classifiedRows = sourceRows.map((message) => ({ message, estimated_tokens: estimateMessageTokens(message) }));
  const byId = new Map(classifiedRows.map((row) => [row.message.id, row]));
  const source = classifyConversationSourceRows(sourceRows);
  const preamble = source.preamble.map((row) => byId.get(row.id)!);
  const rounds = source.rounds.map((round) => buildRound(byId.get(round.activationMarker.id)!, round.rows.map((row) => byId.get(row.id)!)));

  return { preamble, rounds };
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!isConversationBudgetVisible(message)) return 0;
  const structural = [message.role, message.kind, message.tool, message.tool_call_id, message.round_id].filter(Boolean).join(' ');
  return Math.max(1, Math.ceil((message.content.length + structural.length) / 4));
}

function buildRound(marker: ClassifiedMessage, rows: ClassifiedMessage[]): ClassifiedRound {
  if (rows.length === 0) throw new Error('Cannot classify an empty activation round.');
  const roundId = marker.message.id;
  return {
    round_id: roundId,
    activation_marker: marker,
    rows,
    sub_rounds: buildSubRounds(roundId, rows),
    estimated_tokens: rows.reduce((sum, row) => sum + row.estimated_tokens, 0),
  };
}

function buildSubRounds(roundId: string, rows: ClassifiedMessage[]): ClassifiedSubRound[] {
  const byId = new Map(rows.map((row) => [row.message.id, row]));
  return classifySourceSegments(rows.map((row) => row.message)).filter((segment) => segment.kind === 'repair').map((segment) => {
    const subRows = segment.rows.map((row) => byId.get(row.id)!);
    const anchor = subRows[0]!;
    return {
      id: `${roundId}#${anchor.message.id}`,
      kind: 'repair',
      anchor_message_id: anchor.message.id,
      rows: subRows,
    };
  });
}
