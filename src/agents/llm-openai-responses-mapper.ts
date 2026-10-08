import {
  parsePrivateContent,
  assertProviderItemImageMaterialized,
  providerContentParts,
  providerToolResultOutput,
  type ImageDescriptor,
  parseToolCallMessageForModel,
  type ProviderConversationProjection,
} from '../contracts/index.js';

type ResponsesInputItem = Record<string, unknown>;

export function responsesInputFromProviderConversation(
  providerConversation: ProviderConversationProjection,
  targetProducerAccountId: string,
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  const privateByProjection = new Map<string, ReturnType<typeof parsePrivateContent>>();
  for (const message of providerConversation.messages) {
    if (message.kind === 'synthetic_context') continue;
    if (message.kind === 'provider_private') {
      const row = parsePrivateContent(message);
      privateByProjection.set(row.projection_message_id, row);
    }
  }
  for (const message of providerConversation.messages) {
    assertProviderItemImageMaterialized(message);
    if (message.kind === 'synthetic_context') {
      const item = textInput(message.role, message.content);
      if (message.contentBlocks)
        (item.content as unknown[]).push(...providerContentParts(message.contentBlocks, onImageEmitted));
      input.push(item);
      continue;
    }
    if (message.kind === 'provider_private') continue;
    if (message.provider_projection?.kind === 'openai_responses') {
      const row = privateByProjection.get(message.id);
      if (!row)
        throw new Error(
          `Responses projection '${message.id}' is missing private row '${message.provider_projection.private_message_id}'.`,
        );
      for (const item of row.output) {
        if (
          row.producer_account_id !== targetProducerAccountId &&
          item !== null &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'reasoning' &&
          Object.hasOwn(item, 'encrypted_content')
        )
          continue;
        input.push(item as ResponsesInputItem);
      }
      continue;
    }
    if (message.kind === 'tool_result') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: providerToolResultOutput(message, onImageEmitted),
      });
      continue;
    }
    if (message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      continue;
    }
    if (message.kind === 'text' || message.kind === 'model_repair') {
      if (message.role === 'tool')
        throw new Error(`Responses text row '${message.id}' cannot use the tool role.`);
      input.push(textInput(message.role, message.content));
      continue;
    }
    throw new Error(`Unsupported Responses replay row kind '${message.kind}' for '${message.id}'.`);
  }
  return input;
}

function textInput(role: 'system' | 'user' | 'assistant', content: string): ResponsesInputItem {
  return {
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
  };
}
