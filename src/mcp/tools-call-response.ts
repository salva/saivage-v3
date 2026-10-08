import { InvalidArgumentsError, McpInvokeError } from './errors.js';
import { NativeMcpResultSchema } from './native-result.js';

export function mapToolsCallResponse(
  response: Record<string, unknown>,
  serverName: string,
  toolName: string,
): unknown {
  if (response.error) {
    const error = response.error as { code: number; message: string; data?: unknown };
    if (error.code === -32602) throw new InvalidArgumentsError(serverName, toolName, error.data);
    throw new McpInvokeError(
      `MCP server '${serverName}' returned error for tool '${toolName}': ${error.message} (code ${error.code})`,
      `MCP_ERROR_${error.code}`,
      502,
    );
  }
  const result = response.result as
    | (Record<string, unknown> & { content?: unknown; isError?: boolean })
    | undefined;
  if (!result)
    throw new McpInvokeError(
      `MCP server '${serverName}' returned a response with no result for tool '${toolName}'`,
      'MCP_NO_RESULT',
      502,
    );
  const parsed = NativeMcpResultSchema.safeParse(result);
  if (!parsed.success)
    throw new McpInvokeError('Malformed native MCP tool result.', 'MCP_INVALID_RESULT', 502);
  return parsed.data;
}
