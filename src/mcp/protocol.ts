/** MCP protocol types and constants shared by manager and transports. */

import { SAIVAGE_VERSION } from '../version.js';

interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] };
  outputSchema?: { type: 'object'; properties?: Record<string, object>; required?: string[] };
  annotations?: McpToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type McpTransport = 'stdio' | 'streamable-http';
export type McpStatus = 'running' | 'stopped' | 'error';

export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  status: McpStatus;
  pid?: number;
  error?: string;
  startedAt?: string;
  tools_count?: number;
}

export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
export const MCP_INVOKE_TIMEOUT_MS = 30_000;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const STREAMABLE_HTTP_SSE_FRAME_LIMIT_BYTES = 64 * 1024;
export const STREAMABLE_HTTP_SSE_BUFFER_LIMIT_BYTES = 256 * 1024;
export const CLIENT_NAME = 'saivage-mcp-manager';
export const CLIENT_VERSION = SAIVAGE_VERSION;
