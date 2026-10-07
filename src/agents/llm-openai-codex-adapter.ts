import {
  parseToolCallMessageForModel,
  assertProviderItemImageMaterialized,
  type ImageDescriptor,
  LlmRequestError,
  type Candidate,
  type LlmCompleteOptions,
  type ProviderConversationItem,
  type ProviderConversationProjection,
  type LlmProtocolAdapter,
} from '../contracts/index.js';
import { classifyHttpFailure } from './llm-failure-classifiers.js';
import { readOpenAICodexStream } from './llm-codex-parser.js';
import { serializeToolsForCodex } from './tool-definition-serializer.js';

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
  buildRequestBody: ({ candidate, systemPrompt, providerConversation, options, onImageEmitted }) =>
    buildOpenAICodexRequest(candidate, systemPrompt, providerConversation, options, onImageEmitted),
  deriveWire(candidate, transport, body, options) {
    const providerSessionId = body.prompt_cache_key;
    if (typeof providerSessionId !== 'string' || providerSessionId.length === 0)
      throw new Error('Codex admitted request requires a non-empty prompt_cache_key.');
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
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Connection: 'close',
        Authorization: `Bearer ${transport.apiKey}`,
        'chatgpt-account-id': transport.openAICodexAccountId,
        'session-id': providerSessionId,
        originator: 'saivage',
        'OpenAI-Beta': 'responses=experimental',
      },
      requestParams: { stream: true, offered_tools_count: options.tools.length },
    };
  },
  classifyHttpFailure(candidate, response, bodyText, _body, _options, imageBearing) {
    return new LlmRequestError(
      classifyHttpFailure('codex', response, bodyText, {
        suppressBodyPreview: imageBearing,
        provider: candidate.provider,
        model: candidate.model,
      }),
    );
  },
  async parseSuccess(candidate, response, _options, consumption, imageBearing) {
    if (!response.body)
      throw new LlmRequestError({
        kind: 'server_transient',
        provider: candidate.provider,
        status: response.status,
        message: 'OpenAI Codex streaming response has no body',
      });
    return {
      result: await readOpenAICodexStream(
        response.body,
        response.status,
        consumption.signal,
        consumption.onData,
        imageBearing,
      ),
    };
  },
};

function buildOpenAICodexRequest(
  candidate: Candidate,
  systemPrompt: string,
  providerConversation: ProviderConversationProjection,
  opts: LlmCompleteOptions,
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): Record<string, unknown> {
  const messages = providerConversation.messages.filter(
    (message) => message.kind !== 'provider_private',
  );
  const input = codexMessages(messages, onImageEmitted);
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
    instructions: systemPrompt,
    input,
    prompt_cache_key: opts.providerSessionId,
  };
  if (opts.tools.length) {
    body.tools = serializeToolsForCodex(opts.tools);
    body.tool_choice = opts.tool_choice;
    body.parallel_tool_calls = false;
  }
  return body;
}

function codexMessages(
  messages: ProviderConversationItem[],
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): CodexMessage[] {
  const out: CodexMessage[] = [];
  for (const message of messages) {
    assertProviderItemImageMaterialized(message);
    if (message.kind === 'synthetic_context') {
      if (message.role === 'assistant')
        out.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      else if (message.role === 'system') out.push({ role: 'system', content: message.content });
      else
        out.push({
          role: 'user',
          content: [
            { type: 'input_text', text: message.content },
            ...(message.images ?? []).map((image) => {
              onImageEmitted?.(image.descriptor);
              return { type: 'input_image', image_url: image.dataUrl };
            }),
          ],
        });
    } else if (message.role === 'system') out.push({ role: 'system', content: message.content });
    else if (message.role === 'user')
      out.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
    else if (message.role === 'assistant' && message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      out.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    } else if (message.role === 'assistant')
      out.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    else if (message.role === 'tool') {
      if (message.image) onImageEmitted?.(message.image.descriptor);
      out.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.image
          ? [
              { type: 'input_text', text: message.content },
              { type: 'input_image', image_url: message.image.dataUrl },
            ]
          : message.content,
      });
    }
  }
  return out;
}
