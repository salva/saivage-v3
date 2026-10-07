export function callEnvelope(name: string, args: Record<string, unknown> = {}, id = `call-${name}`): string {
  return JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}
