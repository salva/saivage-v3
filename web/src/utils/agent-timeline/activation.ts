import type { AgentConversationEntry } from '../../api/types';
import { parseActivationOpenPayload, type ActivationInstructions } from '@saivage/schemas/activation-instructions';

interface ActivationEntry {
  entry: AgentConversationEntry;
  agentName: string;
  inputId: string;
  cardId: string | null;
  instructions: ActivationInstructions;
}

// Public, selected-segment presentation only; no runtime or persistence imports.
export function activationEntry(entry: AgentConversationEntry): ActivationEntry | null {
  if (entry.kind !== 'activity') return null;
  let payload: ReturnType<typeof parseActivationOpenPayload>;
  try { payload = parseActivationOpenPayload(entry.content, entry.session_id, entry.timestamp); }
  catch (cause) { throw new Error(`Malformed activation_open marker '${entry.id}'.`, { cause }); }
  if (!payload) return null;
  if (entry.role !== 'system' || entry.context_policy.kind !== 'structural' || entry.context_policy.behavior !== 'activation_boundary'
    )
    throw new Error(`Malformed activation_open marker '${entry.id}'.`);
  return { entry, agentName: payload.agent_name, inputId: payload.input_id, cardId: 'card_id' in payload ? payload.card_id : null, instructions: payload.instructions };
}

export function activationEntries(entries: readonly AgentConversationEntry[]): ActivationEntry[] {
  return entries.flatMap((entry) => { const marker = activationEntry(entry); return marker ? [marker] : []; });
}
