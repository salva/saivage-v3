import type { AgentMessage } from '../schemas/index.js';
import type { LlmCompleteOptions, ToolDefinition } from './llm-contracts.js';

export interface LlmRequestDiagnosticMessage {
  role: string;
  kind: string;
  tool?: string;
  content: string;
}

export interface LlmRequestSectionSizes {
  system_prompt_chars: number;
  system_prompt_estimated_tokens: number;
  message_count: number;
  messages_chars: number;
  messages_estimated_tokens: number;
  largest_message: {
    index: number;
    role: string;
    kind: string;
    tool?: string;
    chars: number;
    estimated_tokens: number;
  } | null;
  tool_count: number;
  tools_chars: number;
  tools_estimated_tokens: number;
  max_tokens: number | null;
  phase: LlmCompleteOptions['phase'];
  estimated_prompt_tokens: number;
  estimated_total_tokens_with_completion: number;
  likely_largest_section: 'system_prompt' | 'messages' | 'tools' | 'completion_budget';
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toolsForOptions(opts: LlmCompleteOptions): ToolDefinition[] {
  return opts.phase === 'terminal' ? [opts.terminalToolDefinition] : opts.tools;
}

function measureSections(
  systemPrompt: string,
  messages: LlmRequestDiagnosticMessage[],
  toolCount: number,
  toolsChars: number,
  opts: LlmCompleteOptions,
): LlmRequestSectionSizes {
  let largestMessage: LlmRequestSectionSizes['largest_message'] = null;
  messages.forEach((message, index) => {
    const chars = message.content.length;
    const estimated_tokens = estimateTextTokens(message.content);
    if (!largestMessage || chars > largestMessage.chars) {
      largestMessage = {
        index,
        role: message.role,
        kind: message.kind,
        tool: message.tool,
        chars,
        estimated_tokens,
      };
    }
  });
  const messagesChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const systemPromptTokens = estimateTextTokens(systemPrompt);
  const messagesTokens = messages.reduce(
    (sum, message) => sum + estimateTextTokens(message.content),
    0,
  );
  const toolsTokens = estimateTextTokens('x'.repeat(toolsChars));
  const maxTokens = opts.max_tokens ?? null;
  const candidates = [
    { section: 'system_prompt' as const, tokens: systemPromptTokens },
    { section: 'messages' as const, tokens: messagesTokens },
    { section: 'tools' as const, tokens: toolsTokens },
    { section: 'completion_budget' as const, tokens: maxTokens ?? 0 },
  ].sort((a, b) => b.tokens - a.tokens);

  return {
    system_prompt_chars: systemPrompt.length,
    system_prompt_estimated_tokens: systemPromptTokens,
    message_count: messages.length,
    messages_chars: messagesChars,
    messages_estimated_tokens: messagesTokens,
    largest_message: largestMessage,
    tool_count: toolCount,
    tools_chars: toolsChars,
    tools_estimated_tokens: toolsTokens,
    max_tokens: maxTokens,
    phase: opts.phase,
    estimated_prompt_tokens: systemPromptTokens + messagesTokens + toolsTokens,
    estimated_total_tokens_with_completion: systemPromptTokens + messagesTokens + toolsTokens + (maxTokens ?? 0),
    likely_largest_section: candidates[0].section,
  };
}

export function measureLlmRequestSectionSizes(
  systemPrompt: string,
  messages: AgentMessage[],
  opts: LlmCompleteOptions,
): LlmRequestSectionSizes {
  const toolJson = JSON.stringify(toolsForOptions(opts));
  return measureSections(
    systemPrompt,
    messages.map((message) => ({
      role: message.role,
      kind: message.kind,
      tool: message.tool,
      content: message.content,
    })),
    toolsForOptions(opts).length,
    toolJson.length,
    opts,
  );
}

export function measureFinalOutboundLlmRequestSectionSizes(
  systemPrompt: string,
  messages: LlmRequestDiagnosticMessage[],
  toolCount: number,
  toolsChars: number,
  opts: LlmCompleteOptions,
): LlmRequestSectionSizes {
  return measureSections(systemPrompt, messages, toolCount, toolsChars, opts);
}

export function formatLlmRequestSectionSizes(sizes: LlmRequestSectionSizes): string {
  const largest = sizes.largest_message
    ? `largest_message=index:${sizes.largest_message.index},role:${sizes.largest_message.role},kind:${sizes.largest_message.kind},tool:${sizes.largest_message.tool ?? '_'},chars:${sizes.largest_message.chars},est_tokens:${sizes.largest_message.estimated_tokens}`
    : 'largest_message=none';
  return `[request_section_sizes system_prompt_chars=${sizes.system_prompt_chars} system_prompt_est_tokens=${sizes.system_prompt_estimated_tokens} message_count=${sizes.message_count} messages_chars=${sizes.messages_chars} messages_est_tokens=${sizes.messages_estimated_tokens} ${largest} tool_count=${sizes.tool_count} tools_chars=${sizes.tools_chars} tools_est_tokens=${sizes.tools_estimated_tokens} max_tokens=${sizes.max_tokens ?? 'unset'} phase=${sizes.phase} estimated_prompt_tokens=${sizes.estimated_prompt_tokens} estimated_total_tokens_with_completion=${sizes.estimated_total_tokens_with_completion} likely_largest_section=${sizes.likely_largest_section}]`;
}

export function appendLlmRequestSectionSizesDiagnostic(
  message: string,
  systemPrompt: string,
  messages: AgentMessage[],
  opts: LlmCompleteOptions,
): string {
  return `${message} ${formatLlmRequestSectionSizes(
    measureLlmRequestSectionSizes(systemPrompt, messages, opts),
  )}`;
}

export function appendFinalOutboundLlmRequestSectionSizesDiagnostic(
  message: string,
  systemPrompt: string,
  messages: LlmRequestDiagnosticMessage[],
  toolCount: number,
  toolsChars: number,
  opts: LlmCompleteOptions,
): string {
  return `${message} ${formatLlmRequestSectionSizes(
    measureFinalOutboundLlmRequestSectionSizes(systemPrompt, messages, toolCount, toolsChars, opts),
  )}`;
}
