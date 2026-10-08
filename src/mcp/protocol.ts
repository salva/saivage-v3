/** MCP protocol types and constants shared by manager and transports. */

import { SAIVAGE_VERSION } from '../version.js';
import type { SchemaObject } from 'ajv';

/** Complete received external schema; boolean subschemas and extension keywords are retained. */
type McpObjectSchema = SchemaObject & { type: 'object' };

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
  inputSchema: McpObjectSchema;
  outputSchema?: McpObjectSchema;
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

export const MCP_START_TIMEOUT_MS = 180_000;
export const MCP_INVOKE_TIMEOUT_MS = 30_000;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_WIRE_RESPONSE_LIMIT_BYTES = 48 * 1024 * 1024;
export const CLIENT_NAME = 'saivage-mcp-manager';
export const CLIENT_VERSION = SAIVAGE_VERSION;
