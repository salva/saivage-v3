import type { AgentMessage } from '../../../schemas/index.js';
import { isConversationBudgetVisible } from '../conversation-store.js';

export type SubRoundKind = 'repair' | 'reviewer_rework';

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
  already_compacted_history: PositionedMessage[];
  rounds: ClassifiedRound[];
  total_estimated_tokens: number;
};

export function classifyConversationRounds(messages: AgentMessage[]): ClassifiedConversation {
  const positioned = positionMessages(messages);
  const preamble: PositionedMessage[] = [];
  const alreadyCompactedHistory: PositionedMessage[] = [];
  const rounds: ClassifiedRound[] = [];
  let currentRoundRows: PositionedMessage[] | null = null;
  let currentMarker: PositionedMessage | null = null;
  let sawActivation = false;

  for (const row of positioned) {
    if (row.message.kind === 'context_compaction') {
      alreadyCompactedHistory.push(row);
      continue;
    }
    if (isActivationOpenMarker(row.message)) {
      if (currentRoundRows && currentMarker) rounds.push(buildRound(currentMarker, currentRoundRows));
      sawActivation = true;
      currentMarker = row;
      currentRoundRows = [row];
      continue;
    }
    if (!sawActivation) {
      preamble.push(row);
      continue;
    }
    if (!currentRoundRows) throw new Error('Round classifier reached activated state without an open round.');
    currentRoundRows.push(row);
  }

  if (currentRoundRows && currentMarker) rounds.push(buildRound(currentMarker, currentRoundRows));

  return {
    preamble,
    already_compacted_history: alreadyCompactedHistory,
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
  const anchors = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.message.kind === 'model_repair' || isFailedToolResult(row.message));

  return anchors.map(({ row, index }, anchorIndex) => {
    const next = anchors[anchorIndex + 1]?.index ?? rows.length;
    const subRows = rows.slice(index, next);
    return {
      id: `${roundId}#${row.message.id}`,
      kind: isReviewerReworkToolResult(row.message) ? 'reviewer_rework' : 'repair',
      anchor_message_id: row.message.id,
      rows: subRows,
      start_token: subRows[0].start_token,
      end_token: subRows[subRows.length - 1].end_token,
    };
  });
}

function isActivationOpenMarker(message: AgentMessage): boolean {
  if (message.kind !== 'activity') return false;
  const parsed = parseJsonObject(message.content);
  return parsed.event === 'activation_open';
}

function isFailedToolResult(message: AgentMessage): boolean {
  if (message.kind !== 'tool_result') return false;
  const parsed = parseJsonObject(message.content);
  return parsed.success === false;
}

function isReviewerReworkToolResult(message: AgentMessage): boolean {
  if (!isFailedToolResult(message)) return false;
  const parsed = parseJsonObject(message.content);
  return typeof parsed.error === 'string' && /^Reviewer requested rework at .*review\.md/.test(parsed.error);
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}
