export function parseProtocolToolArgs(raw: string):
  | { kind: 'ok'; args: Record<string, unknown> }
  | { kind: 'violation'; violation: 'tool_args_invalid_json' | 'tool_args_not_object'; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'violation',
      violation: 'tool_args_invalid_json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'violation',
      violation: 'tool_args_not_object',
      detail: `tool arguments must be a JSON object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    };
  }
  return { kind: 'ok', args: parsed as Record<string, unknown> };
}
