import type { AgentMessage, ConversationSessionId } from '../schemas/index.js';

interface OpenAIResponsesPrivateRowContent {
  transport: 'openai-responses';
  source_input_id: string;
  projection_message_id: string;
  provider: string;
  model: string;
  output: unknown[];
}

export function parsePrivateContent(message: AgentMessage): OpenAIResponsesPrivateRowContent {
  if (message.kind !== 'provider_private') throw new Error(`Message '${message.id}' is not a provider_private row.`);
  const parsed = JSON.parse(message.content) as OpenAIResponsesPrivateRowContent;
  if (parsed.transport !== 'openai-responses') throw new Error(`Provider private row '${message.id}' has unsupported transport.`);
  if (!parsed.source_input_id || !parsed.projection_message_id || !parsed.provider || !parsed.model || !Array.isArray(parsed.output)) throw new Error(`Provider private row '${message.id}' is malformed.`);
  return parsed;
}

export function validateResponsesPairs(sourceSessionId: ConversationSessionId, messages: AgentMessage[]): void {
  const privateById = new Map<string, { message: AgentMessage; content: OpenAIResponsesPrivateRowContent }>();
  const visibleByInput = new Map<string, AgentMessage[]>();
  const privateByInput = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    if (message.session_id !== sourceSessionId) throw new Error(`Responses projection row '${message.id}' belongs to session '${message.session_id}', not source session '${sourceSessionId}'.`);
    if (message.kind === 'provider_private') {
      const content = parsePrivateContent(message);
      privateById.set(message.id, { message, content });
      const list = privateByInput.get(content.source_input_id) ?? [];
      list.push(message);
      privateByInput.set(content.source_input_id, list);
    }
    if (message.provider_projection?.kind === 'openai_responses') {
      const list = visibleByInput.get(message.provider_projection.source_input_id) ?? [];
      list.push(message);
      visibleByInput.set(message.provider_projection.source_input_id, list);
    }
  }
  for (const [sourceInputId, rows] of privateByInput) if (rows.length !== 1) throw new Error(`Responses private rows for input '${sourceInputId}' are duplicated.`);
  for (const [sourceInputId, rows] of visibleByInput) if (rows.length !== 1) throw new Error(`Responses visible projections for input '${sourceInputId}' are duplicated.`);
  for (const visible of [...visibleByInput.values()].flat()) {
    const marker = visible.provider_projection;
    if (!marker) throw new Error('unreachable');
    const privateEntry = privateById.get(marker.private_message_id);
    if (!privateEntry) throw new Error(`Responses visible projection '${visible.id}' is missing private row '${marker.private_message_id}'.`);
    if (privateEntry.content.source_input_id !== marker.source_input_id) throw new Error(`Responses projection '${visible.id}' has mismatched source_input_id.`);
    if (privateEntry.content.projection_message_id !== visible.id) throw new Error(`Responses projection '${visible.id}' is not referenced by private row '${marker.private_message_id}'.`);
  }
  for (const [privateId, entry] of privateById) {
    const projection = messages.find((message) => message.id === entry.content.projection_message_id && message.provider_projection?.private_message_id === privateId);
    if (!projection) throw new Error(`Responses private row '${privateId}' is missing marked visible projection '${entry.content.projection_message_id}'.`);
  }
}
