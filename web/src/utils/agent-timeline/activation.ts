import type { AgentConversationEntry } from '../../api/types';

interface ActivationEntry {
  entry: AgentConversationEntry;
  agentName: string;
  inputId: string;
  cardId: string | null;
}

// Public, selected-segment presentation only; no runtime or persistence imports.
export function activationEntry(entry: AgentConversationEntry): ActivationEntry | null {
  if (entry.kind !== 'activity') return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(entry.content); } catch { return null; }
  if (!payload || payload.event !== 'activation_open') return null;
  const [, agentName, scope] = entry.session_id.split(':');
  const cardId = scope === 'global' ? null : scope;
  const keys = cardId === null
    ? ['agent_name', 'event', 'input_id', 'timestamp']
    : ['agent_name', 'card_id', 'event', 'input_id', 'timestamp'];
  if (entry.role !== 'system' || entry.context_policy.kind !== 'structural' || entry.context_policy.behavior !== 'activation_boundary'
    || Object.keys(payload).sort().join(',') !== keys.join(',')
    || payload.agent_name !== agentName || payload.timestamp !== entry.timestamp
    || typeof payload.input_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.input_id)
    || (cardId !== null && payload.card_id !== cardId))
    throw new Error(`Malformed activation_open marker '${entry.id}'.`);
  return { entry, agentName, inputId: payload.input_id, cardId };
}

export function activationEntries(entries: readonly AgentConversationEntry[]): ActivationEntry[] {
  return entries.flatMap((entry) => { const marker = activationEntry(entry); return marker ? [marker] : []; });
}
