import { redactTextForOutbound } from '../redaction/index.js';

export { LlmRequestError, unwrapFailure } from './llm-failure.js';
export type { LlmTransportFailure } from './llm-failure.js';

export function redactProviderErrorText(text: string, source: string = 'llm-provider-gateway'): string {
  return redactTextForOutbound(text, 'provider.diagnostic', { source });
}
