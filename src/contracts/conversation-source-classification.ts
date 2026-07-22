import { conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../schemas/index.js';

export type SourceSegment = { kind: 'initial' | 'repair'; rows: AgentMessage[] };
export type SourceRound = { label: string; activationMarker: AgentMessage; rows: AgentMessage[]; segments: SourceSegment[] };
export type SourceConversationClassification = { preamble: AgentMessage[]; rounds: SourceRound[] };

export function classifyConversationSourceRows(sourceSessionId: ConversationSessionId, rows: readonly AgentMessage[]): SourceConversationClassification {
  const preamble: AgentMessage[] = [];
  const rounds: SourceRound[] = [];
  let current: AgentMessage[] | null = null;

  for (const row of rows) {
    if (row.kind === 'context_compaction') throw new Error('Source classification does not accept context_compaction rows.');
    if (isActivationOpenMarker(sourceSessionId, row)) {
      if (current) rounds.push(buildSourceRound(current));
      current = [row];
    } else if (current) {
      current.push(row);
    } else {
      preamble.push(row);
    }
  }
  if (current) rounds.push(buildSourceRound(current));
  if (conversationSessionIdentity(sourceSessionId).cardId===null && preamble.length > 0) {
    throw new Error(`Global-agent conversation '${sourceSessionId}' must start with an exact activation_open marker and have an empty preamble.`);
  }
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

function isActivationOpenMarker(sourceSessionId: ConversationSessionId, message: AgentMessage): boolean {
  if (message.kind !== 'activity') return false;
  const payload = parseJsonObject(message.content);
  if (payload.event !== 'activation_open') return false;
  const identity = conversationSessionIdentity(sourceSessionId);
  const expectedAgent = identity.agentName;
  const expectedKeys = identity.cardId===null
    ? ['agent_name','event', 'input_id', 'timestamp']
    : ['agent_name','card_id', 'event', 'input_id', 'timestamp'];
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Conversation '${sourceSessionId}' has a malformed ${expectedAgent} activation_open marker.`);
  }
  if (payload.agent_name !== expectedAgent || payload.timestamp !== message.timestamp || !isCanonicalUuid(payload.input_id)) {
    throw new Error(`Conversation '${sourceSessionId}' has a malformed ${expectedAgent} activation_open marker.`);
  }
  if (identity.cardId!==null && payload.card_id !== identity.cardId) {
    throw new Error(`Conversation '${sourceSessionId}' has a malformed ${expectedAgent} activation_open marker.`);
  }
  return true;
}

function isCanonicalUuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
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
