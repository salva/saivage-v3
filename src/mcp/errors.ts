/** Structured MCP invocation errors. */

export class McpInvokeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'McpInvokeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ServerNotRunningError extends McpInvokeError {
  constructor(serverName: string) {
    super(`MCP server '${serverName}' is not running`, 'SERVER_NOT_RUNNING', 404);
    this.name = 'ServerNotRunningError';
  }
}

export class ToolNotFoundError extends McpInvokeError {
  constructor(serverName: string, toolName: string) {
    super(`Tool '${toolName}' not found on MCP server '${serverName}'`, 'TOOL_NOT_FOUND', 404);
    this.name = 'ToolNotFoundError';
  }
}

export class InvalidArgumentsError extends McpInvokeError {
  public readonly data: unknown;

  constructor(serverName: string, toolName: string, data?: unknown) {
    const dataStr = data !== undefined ? `: ${JSON.stringify(data)}` : '';
    super(`Invalid arguments for tool '${toolName}' on server '${serverName}'${dataStr}`, 'INVALID_ARGUMENTS', 400);
    this.name = 'InvalidArgumentsError';
    this.data = data;
  }
}

export class TimeoutError extends McpInvokeError {
  constructor(serverName: string, toolName: string, timeoutMs: number) {
    super(`Tool '${toolName}' on server '${serverName}' timed out after ${timeoutMs}ms`, 'TIMEOUT', 408);
    this.name = 'TimeoutError';
  }
}

export class TransportError extends McpInvokeError {
  constructor(serverName: string, detail: string) {
    super(`Transport error on MCP server '${serverName}': ${detail}`, 'TRANSPORT_ERROR', 502);
    this.name = 'TransportError';
  }
}
