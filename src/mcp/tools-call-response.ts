import { InvalidArgumentsError, McpInvokeError } from './errors.js';

export function mapToolsCallResponse(response: Record<string, unknown>, serverName: string, toolName: string): unknown {
  if (response.error) {
    const error = response.error as { code: number; message: string; data?: unknown };
    if (error.code === -32602) throw new InvalidArgumentsError(serverName, toolName, error.data);
    throw new McpInvokeError(`MCP server '${serverName}' returned error for tool '${toolName}': ${error.message} (code ${error.code})`, `MCP_ERROR_${error.code}`, 502);
  }
  const result = response.result as (Record<string, unknown> & { content?: unknown; isError?: boolean }) | undefined;
  if (!result) throw new McpInvokeError(`MCP server '${serverName}' returned a response with no result for tool '${toolName}'`, 'MCP_NO_RESULT', 502);
  if (result.isError === true) throw new McpInvokeError(`Tool '${toolName}' on server '${serverName}' reported an error`, 'TOOL_EXECUTION_ERROR', 422);
  return result.content !== undefined ? result.content : result;
}
