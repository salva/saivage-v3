import { redactTextForOutbound } from '../redaction/index.js';

export { LlmRequestError, unwrapFailure } from '../contracts/llm-failure.js';
export type { LlmTransportFailure } from '../contracts/llm-failure.js';

export function redactProviderErrorText(text: string): string {
  return redactTextForOutbound(text);
}
