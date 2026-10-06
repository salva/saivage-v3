import { llmUsageSchema, LlmRequestError, type LlmUsage } from '../contracts/index.js';

export function extractChatUsage(value: unknown, provider: string): LlmUsage | undefined {
  return extractUsage(
    value,
    provider,
    'prompt_tokens',
    'completion_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  );
}

export function extractResponsesUsage(value: unknown, provider: string): LlmUsage | undefined {
  return extractUsage(
    value,
    provider,
    'input_tokens',
    'output_tokens',
    'input_tokens_details',
    'output_tokens_details',
  );
}

function extractUsage(
  value: unknown,
  provider: string,
  inputKey: string,
  outputKey: string,
  inputDetailsKey: string,
  outputDetailsKey: string,
): LlmUsage | undefined {
  const usage = container(value, 'usage', provider);
  if (!usage) return undefined;
  const inputDetails = container(usage[inputDetailsKey], `usage.${inputDetailsKey}`, provider);
  const outputDetails = container(usage[outputDetailsKey], `usage.${outputDetailsKey}`, provider);
  const projected: LlmUsage = {};
  for (const [key, count, path] of [
    ['prompt_tokens', usage[inputKey], `usage.${inputKey}`],
    ['completion_tokens', usage[outputKey], `usage.${outputKey}`],
    ['total_tokens', usage.total_tokens, 'usage.total_tokens'],
    ['cached_input_tokens', inputDetails?.cached_tokens, `usage.${inputDetailsKey}.cached_tokens`],
    [
      'reasoning_output_tokens',
      outputDetails?.reasoning_tokens,
      `usage.${outputDetailsKey}.reasoning_tokens`,
    ],
  ] as const) {
    if (count === undefined || count === null) continue;
    const parsed = llmUsageSchema.safeParse({ [key]: count });
    if (!parsed.success) throw invalidUsage(path, provider);
    Object.assign(projected, parsed.data);
  }
  return Object.keys(projected).length ? projected : undefined;
}

function container(
  value: unknown,
  path: string,
  provider: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidUsage(path, provider);
  return value as Record<string, unknown>;
}

function invalidUsage(path: string, provider: string): LlmRequestError {
  return new LlmRequestError({
    kind: 'parse_error',
    provider,
    message: `Invalid provider token usage at ${path}.`,
  });
}
