import { TransportError } from './errors.js';
import type { McpToolDefinition } from './protocol.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Decode consumed discovery facts, leaving schema-language admission to invocation. */
export function decodeMcpListPage(
  serverName: string,
  response: Record<string, unknown>,
  names: Set<string>,
): { tools: McpToolDefinition[]; nextCursor?: string } {
  const invalid = (): never => {
    throw new TransportError(serverName, 'tools/list returned malformed catalog');
  };
  if (response.jsonrpc !== '2.0') return invalid();
  if (response.error !== undefined) {
    const code = object(response.error) ? response.error.code : undefined;
    throw new TransportError(
      serverName,
      `tools/list rejected${typeof code === 'number' && Number.isFinite(code) ? ` (code ${code})` : ''}`,
    );
  }
  const result = response.result;
  if (!object(result) || !Array.isArray(result.tools)) return invalid();
  if (result.nextCursor !== undefined && typeof result.nextCursor !== 'string') return invalid();
  if (result._meta !== undefined && !object(result._meta)) return invalid();
  for (const tool of result.tools) {
    if (!object(tool) || typeof tool.name !== 'string' || !tool.name.length || names.has(tool.name))
      return invalid();
    for (const key of ['title', 'description'])
      if (tool[key] !== undefined && typeof tool[key] !== 'string') return invalid();
    if (!object(tool.inputSchema) || tool.inputSchema.type !== 'object') return invalid();
    if (
      tool.outputSchema !== undefined &&
      (!object(tool.outputSchema) || tool.outputSchema.type !== 'object')
    )
      return invalid();
    if (tool._meta !== undefined && !object(tool._meta)) return invalid();
    if (tool.annotations !== undefined) {
      if (!object(tool.annotations)) return invalid();
      if (tool.annotations.title !== undefined && typeof tool.annotations.title !== 'string')
        return invalid();
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
        if (tool.annotations[key] !== undefined && typeof tool.annotations[key] !== 'boolean')
          return invalid();
    }
    names.add(tool.name);
  }
  return {
    tools: result.tools as McpToolDefinition[],
    nextCursor: result.nextCursor as string | undefined,
  };
}
