// Web mirror of src/agents/persisted-tool-call.ts. Read-only; web has no F08
// LlmFailure union, so malformed input raises a plain Error.

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
    throw new Error(`persisted tool-call row is not an object (got ${typeof row})`);
  }
  if (Array.isArray((row as { toolCalls?: unknown }).toolCalls)) {
    throw new Error('persistence row uses deprecated {toolCalls:[...]} wrapper; expected one tool_call per row');
  }
  const toolCalls = (row as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new Error(`persisted tool-call row must have exactly one entry in tool_calls (got ${Array.isArray(toolCalls) ? toolCalls.length : typeof toolCalls})`);
  }
  const call = toolCalls[0];
  if (!isObject(call) || call.type !== 'function' || typeof call.id !== 'string' || !isObject(call.function)) {
    throw new Error('persisted tool-call entry is malformed (expected {id, type:"function", function:{name, arguments}})');
  }
  const fn = call.function as { name?: unknown; arguments?: unknown };
  if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    throw new Error('persisted tool-call function must have string name and string arguments');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fn.arguments);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`tool-call arguments are not valid JSON: ${detail}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`tool-call arguments must parse to an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
  }
  return { id: call.id, name: fn.name, args: parsed };
}
