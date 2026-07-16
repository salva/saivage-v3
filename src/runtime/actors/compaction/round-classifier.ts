import type { AgentMessage } from '../../../schemas/index.js';
import { classifyConversationSourceRows, classifySourceSegments } from '../../../contracts/conversation-source-classification.js';
import { isConversationBudgetVisible } from '../conversation-session.js';

export type SubRoundKind = 'repair';

export type PositionedMessage = {
  message: AgentMessage;
  estimated_tokens: number;
  start_token: number;
  end_token: number;
};

export type ClassifiedSubRound = {
  id: string;
  kind: SubRoundKind;
  anchor_message_id: string;
  rows: PositionedMessage[];
  start_token: number;
  end_token: number;
};

export type ClassifiedRound = {
  round_id: string;
  activation_marker: PositionedMessage;
  rows: PositionedMessage[];
  sub_rounds: ClassifiedSubRound[];
  start_token: number;
  end_token: number;
};

export type ClassifiedConversation = {
  preamble: PositionedMessage[];
  rounds: ClassifiedRound[];
  total_estimated_tokens: number;
};

export function classifyConversationRounds(messages: AgentMessage[]): ClassifiedConversation {
  const sourceRows = messages.filter((message) => message.kind !== 'context_compaction');
  const positioned = positionMessages(sourceRows);
  const byId = new Map(positioned.map((row) => [row.message.id, row]));
  const source = classifyConversationSourceRows(sourceRows);
  const preamble = source.preamble.map((row) => byId.get(row.id)!);
  const rounds = source.rounds.map((round) => buildRound(byId.get(round.activationMarker.id)!, round.rows.map((row) => byId.get(row.id)!)));

  return {
    preamble,
    rounds,
    total_estimated_tokens: positioned.length === 0 ? 0 : positioned[positioned.length - 1].end_token,
  };
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!isConversationBudgetVisible(message)) return 0;
  const structural = [message.role, message.kind, message.tool, message.tool_call_id, message.round_id].filter(Boolean).join(' ');
  return Math.max(1, Math.ceil((message.content.length + structural.length) / 4));
}

export function positionMessages(messages: AgentMessage[]): PositionedMessage[] {
  let cursor = 0;
  return messages.map((message) => {
    const estimated = estimateMessageTokens(message);
    const positioned = { message, estimated_tokens: estimated, start_token: cursor, end_token: cursor + estimated };
    cursor += estimated;
    return positioned;
  });
}

function buildRound(marker: PositionedMessage, rows: PositionedMessage[]): ClassifiedRound {
  if (rows.length === 0) throw new Error('Cannot classify an empty activation round.');
  const roundId = marker.message.id;
  return {
    round_id: roundId,
    activation_marker: marker,
    rows,
    sub_rounds: buildSubRounds(roundId, rows),
    start_token: rows[0].start_token,
    end_token: rows[rows.length - 1].end_token,
  };
}

function buildSubRounds(roundId: string, rows: PositionedMessage[]): ClassifiedSubRound[] {
  const byId = new Map(rows.map((row) => [row.message.id, row]));
  return classifySourceSegments(rows.map((row) => row.message)).filter((segment) => segment.kind === 'repair').map((segment) => {
    const subRows = segment.rows.map((row) => byId.get(row.id)!);
    const anchor = subRows[0]!;
    return {
      id: `${roundId}#${anchor.message.id}`,
      kind: 'repair',
      anchor_message_id: anchor.message.id,
      rows: subRows,
      start_token: subRows[0].start_token,
      end_token: subRows[subRows.length - 1].end_token,
    };
  });
}
