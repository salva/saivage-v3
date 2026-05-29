import type { z } from 'zod';
import { LlmRequestError } from './llm-failure.js';

export interface PersistedToolCallRow {
  role: 'assistant';
  tool_calls: [
    {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    },
  ];
}

export interface PersistedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseToolCallMessage(row: unknown): PersistedToolCall {
  if (!isObject(row)) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'legacy_message_shape',
      provider: 'persistence',
      message: `persisted tool-call row is not an object (got ${typeof row})`,
    });
  }
  if (Array.isArray((row as { toolCalls?: unknown }).toolCalls)) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'legacy_message_shape',
      provider: 'persistence',
      message: 'persistence row uses deprecated {toolCalls:[...]} wrapper; expected one tool_call per row',
    });
  }
  const toolCalls = (row as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'legacy_message_shape',
      provider: 'persistence',
      message: `persisted tool-call row must have exactly one entry in tool_calls (got ${Array.isArray(toolCalls) ? toolCalls.length : typeof toolCalls})`,
    });
  }
  const call = toolCalls[0];
  if (!isObject(call) || call.type !== 'function' || typeof call.id !== 'string' || !isObject(call.function)) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'legacy_message_shape',
      provider: 'persistence',
      message: 'persisted tool-call entry is malformed (expected {id, type:"function", function:{name, arguments}})',
    });
  }
  const fn = call.function as { name?: unknown; arguments?: unknown };
  if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'legacy_message_shape',
      provider: 'persistence',
      message: 'persisted tool-call function must have string name and string arguments',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fn.arguments);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'tool_arguments_invalid_json',
      provider: 'persistence',
      message: `tool-call arguments are not valid JSON: ${detail}`,
    });
  }
  if (!isObject(parsed)) {
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'tool_arguments_invalid_json',
      provider: 'persistence',
      message: `tool-call arguments must parse to an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    });
  }
  return { id: call.id, name: fn.name, args: parsed };
}

export function serializeToolCallMessage(call: { id: string; name: string; args: Record<string, unknown> }): PersistedToolCallRow {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ],
  };
}

export function parseToolCallArgsAgainstSchema(args: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new LlmRequestError({
      kind: 'contract_mismatch',
      subtype: 'tool_arguments_schema_violation',
      provider: 'gateway-protocol',
      message: `tool-call arguments failed schema validation: ${summary}`,
    });
  }
  return result.data as Record<string, unknown>;
}
