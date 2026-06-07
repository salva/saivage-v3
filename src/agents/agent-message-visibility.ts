import type { AgentMessage } from '../schemas/index.js';

export function isAgentMessageVisibleToModel(message: AgentMessage): boolean {
  return message.kind !== 'model_issue';
}

export function filterAgentMessagesForModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(isAgentMessageVisibleToModel);
}
