import { redactTextForOutbound } from '../redaction/index.js';

export { LlmRequestError, unwrapFailure } from '../contracts/llm-failure.js';
export type { LlmTransportFailure } from '../contracts/llm-failure.js';

export function redactProviderErrorText(text: string, source: string = 'llm-provider-attempt'): string {
  return redactTextForOutbound(text, 'provider.diagnostic', { source });
}
