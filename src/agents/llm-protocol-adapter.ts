import type { LlmProtocolAdapter, TransportProtocol } from '../contracts/index.js';
import { openAIChatAdapter } from './llm-openai-chat-adapter.js';
import { openAIResponsesAdapter } from './llm-openai-responses-adapter.js';
import { openAICodexAdapter } from './llm-openai-codex-adapter.js';

export function selectLlmProtocolAdapter(protocol: TransportProtocol): LlmProtocolAdapter {
  switch (protocol) {
    case 'openai-chat-completions':
      return openAIChatAdapter;
    case 'openai-responses':
      return openAIResponsesAdapter;
    case 'openai-codex-backend':
      return openAICodexAdapter;
    default: {
      const impossibleProtocol: never = protocol;
      throw new Error(`Unsupported LLM transport protocol '${String(impossibleProtocol)}'.`);
    }
  }
}
