import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from './provider.js';
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';
import type { CapabilityRequest } from './provider-capabilities.js';

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

export type TerminalChoice =
  | { kind: 'auto' }
  | { kind: 'required_named'; toolName: string };

export interface LlmModelParams {
  temperature?: number;
  max_tokens?: number;
}

interface LlmCompleteOptionsBase extends LlmModelParams {
  stream?: boolean;
  signal?: AbortSignal;
  recorder?: LlmExchangeRecorder;
  capabilityRequest?: CapabilityRequest;
  contract_id: string;
}

export interface LlmCompleteOptionsTools extends LlmCompleteOptionsBase {
  phase: 'tools';
  tools: ToolDefinition[];
  tool_choice: TerminalChoice;
}

export interface LlmCompleteOptionsTerminal extends LlmCompleteOptionsBase {
  phase: 'terminal';
  terminalToolName: string;
  terminalToolDefinition: ToolDefinition;
}

export type LlmCompleteOptions = LlmCompleteOptionsTools | LlmCompleteOptionsTerminal;

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type LlmCompleteResult =
  | { kind: 'tool_calls'; tool_calls: ToolCall[]; usage?: LlmUsage }
  | { kind: 'message'; content: string; usage?: LlmUsage };

export interface LlmInvocationClient {
  complete(
    candidate: Candidate,
    systemPrompt: string,
    messages: AgentMessage[],
    sessionId: string,
    opts: LlmCompleteOptions,
  ): Promise<LlmCompleteResult>;
}

export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  sessionId: string,
  opts: LlmCompleteOptions,
) => Promise<LlmCompleteResult>;
