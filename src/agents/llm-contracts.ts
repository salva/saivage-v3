import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from './provider.js';
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmCompleteResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface LlmCompleteOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  recorder?: LlmExchangeRecorder;
}

export interface LlmInvocationClient {
  complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    sessionId: string,
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompleteResult>;
}

export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  sessionId: string,
  opts?: LlmCompleteOptions,
) => Promise<string>;

export function parsePersistedToolCalls(content: string): ToolCall[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)) {
      return (parsed as { toolCalls: ToolCall[] }).toolCalls;
    }
  } catch {
    // Fall through to empty list.
  }
  return [];
}
