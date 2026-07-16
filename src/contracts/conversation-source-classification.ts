import type { AgentMessage } from '../schemas/index.js';

export type SourceSegment = { kind: 'initial' | 'repair'; rows: AgentMessage[] };
export type SourceRound = { label: string; activationMarker: AgentMessage; rows: AgentMessage[]; segments: SourceSegment[] };
export type SourceConversationClassification = { preamble: AgentMessage[]; rounds: SourceRound[] };

export function classifyConversationSourceRows(rows: readonly AgentMessage[]): SourceConversationClassification {
  const preamble: AgentMessage[] = [];
  const rounds: SourceRound[] = [];
  let current: AgentMessage[] | null = null;

  for (const row of rows) {
    if (row.kind === 'context_compaction') throw new Error('Source classification does not accept context_compaction rows.');
    if (isActivationOpenMarker(row)) {
      if (current) rounds.push(buildSourceRound(current));
      current = [row];
    } else if (current) {
      current.push(row);
    } else {
      preamble.push(row);
    }
  }
  if (current) rounds.push(buildSourceRound(current));
  return { preamble, rounds };
}

function buildSourceRound(rows: AgentMessage[]): SourceRound {
  const activationMarker = rows[0]!;
  return { label: activationMarker.id, activationMarker, rows, segments: classifySourceSegments(rows) };
}

export function classifySourceSegments(rows: readonly AgentMessage[]): SourceSegment[] {
  const repairIndexes = rows.flatMap((row, index) => isRepairAnchor(row) ? [index] : []);
  const segments: SourceSegment[] = [];
  const firstRepair = repairIndexes[0] ?? rows.length;
  if (firstRepair > 0) segments.push({ kind: 'initial', rows: rows.slice(0, firstRepair) });
  repairIndexes.forEach((index, ordinal) => segments.push({ kind: 'repair', rows: rows.slice(index, repairIndexes[ordinal + 1] ?? rows.length) }));
  return segments;
}

function isActivationOpenMarker(message: AgentMessage): boolean {
  if (message.kind !== 'activity') return false;
  return parseJsonObject(message.content).event === 'activation_open';
}

function isRepairAnchor(message: AgentMessage): boolean {
  return message.kind === 'model_repair' || (message.kind === 'tool_result' && parseJsonObject(message.content).success === false);
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
