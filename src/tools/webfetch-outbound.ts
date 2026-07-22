import {
  WebfetchInvocationSchema,
  WebfetchResultSchema,
  type WebfetchInvocation,
  type WebfetchResult,
} from '../contracts/webfetch.js';
import { redactTextForOutbound, redactUrl } from '../redaction/text.js';

export function projectWebfetchInvocationForOutbound(value: WebfetchInvocation): WebfetchInvocation {
  const invocation = WebfetchInvocationSchema.parse(value);
  return WebfetchInvocationSchema.parse({ ...invocation, url: redactUrl(invocation.url) });
}

export function projectWebfetchResultForOutbound(value: WebfetchResult): WebfetchResult {
  const result = WebfetchResultSchema.parse(value);
  if (!result.success) return WebfetchResultSchema.parse({ success: false, error: redactTextForOutbound(result.error) });

  const data = result.data;
  const common = { ...data, redacted_url: redactUrl(data.redacted_url) };
  if ('text' in data) return WebfetchResultSchema.parse({ success: true, data: { ...common, text: redactTextForOutbound(data.text) } });
  if ('write' in data && 'propagation' in data.write && !data.write.propagation.ok) {
    return WebfetchResultSchema.parse({
      success: true,
      data: {
        ...common,
        write: { ...data.write, propagation: { ...data.write.propagation, error: redactTextForOutbound(data.write.propagation.error) } },
      },
    });
  }
  return WebfetchResultSchema.parse({ success: true, data: common });
}
