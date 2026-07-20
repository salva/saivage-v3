import type { AgentMessage } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { parseToolCallMessageForModel } from '../contracts/persisted-tool-call.js';
import {
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../schemas/message-identity.js';
import type { LlmCompleteOptions, ProviderConversationProjection } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { readOpenAICodexStream } from './llm-codex-parser.js';
import { serializeToolsForCodex } from './tool-definition-serializer.js';
import type { LlmProtocolAdapter } from './llm-protocol-adapter.js';

interface CodexInputText {
  type: 'input_text';
  text: string;
}
type CodexMessage =
  | { role: 'user'; content: CodexInputText[] }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { role: 'system'; content: string }
  | Record<string, unknown>;

export const openAICodexAdapter: LlmProtocolAdapter = {
  credentialRequirement: 'standard',
  buildRequestBody: ({ candidate, systemPrompt, providerConversation, options }) =>
    buildOpenAICodexRequest(candidate, systemPrompt, providerConversation, options),
  deriveWire(candidate, transport, _body, options) {
    if (!transport.apiKey || !transport.openAICodexAccountId)
      throw new LlmRequestError({
        kind: 'auth_permanent',
        provider: candidate.provider,
        status: 401,
        message: 'openai-codex dispatch requires resolved credential and account id.',
      });
    const base = transport.baseUrl.replace(/\/+$/, '');
    const endpoint = base.endsWith('/codex/responses')
      ? base
      : base.endsWith('/codex')
        ? `${base}/responses`
        : `${base}/codex/responses`;
    return {
      endpoint,
      transport: 'codex',
      streaming: true,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Connection: 'close',
        Authorization: `Bearer ${transport.apiKey}`,
        'chatgpt-account-id': transport.openAICodexAccountId,
        originator: 'saivage',
        'OpenAI-Beta': 'responses=experimental',
      },
      requestParams: { stream: true, offered_tools_count: options.tools.length },
    };
  },
  classifyHttpFailure(candidate, response, bodyText) {
    return new LlmRequestError(
      classifyHttpFailure('codex', response, bodyText, {
        provider: candidate.provider,
        model: candidate.model,
      }),
    );
  },
  async parseSuccess(candidate, response) {
    if (!response.body)
      throw new LlmRequestError({
        kind: 'server_transient',
        provider: candidate.provider,
        status: response.status,
        message: 'OpenAI Codex streaming response has no body',
      });
    return { result: await readOpenAICodexStream(response.body, response.status) };
  },
};

export function buildOpenAICodexRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
): Record<string, unknown> {
  const messages = providerConversation.messages.filter(
    (message) => message.kind !== 'provider_private',
  );
  const input = codexMessages(messages);
  if (!input.length)
    input.push({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Proceed with the task described in the instructions.' },
      ],
    });
  const body: Record<string, unknown> = {
    model: candidate.model,
    store: false,
    stream: true,
    instructions: [
      systemPrompt,
      ...messages.filter((message) => message.role === 'system').map((message) => message.content),
    ].join('\n\n--- system context ---\n'),
    input,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForCodex(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  return body;
}

export function codexMessages(messages: AgentMessage[]): CodexMessage[] {
  const settled = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      seen.add(`${sourceInputIdFromToolCallMessageId(message.id, call.id)}\0${call.id}`);
    } else if (message.role === 'tool') {
      if (!message.tool_call_id)
        throw new Error(`Codex tool settlement '${message.id}' is missing tool_call_id.`);
      const key = `${sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id)}\0${message.tool_call_id}`;
      if (seen.has(key)) settled.add(key);
    }
  }
  const out: CodexMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user')
      out.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
    else if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      if (settled.has(`${sourceInputIdFromToolCallMessageId(message.id, call.id)}\0${call.id}`))
        out.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
    } else if (message.role === 'assistant')
      out.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    else if (message.role === 'tool') {
      const id = message.tool_call_id;
      if (id && settled.has(`${sourceInputIdFromToolResultMessageId(message.id, id)}\0${id}`))
        out.push({ type: 'function_call_output', call_id: id, output: message.content });
    }
  }
  return out;
}
