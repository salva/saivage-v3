import {
  McpReconcileResultSchema,
  McpToolCallArgumentsSchema,
  McpToolCallResultSchema,
  type McpReconcileResult,
  type McpToolCallArguments,
  type McpToolCallResult,
} from '../contracts/mcp-invocation.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { redactTextForOutbound } from '../redaction/text.js';
import type { ToolResult } from './invocation.js';

export function projectMcpToolCallArgumentsForOutbound(value: McpToolCallArguments): McpToolCallArguments {
  const argumentsValue = McpToolCallArgumentsSchema.parse(value);
  return McpToolCallArgumentsSchema.parse({
    serverName: argumentsValue.serverName,
    toolName: argumentsValue.toolName,
    ...(argumentsValue.args === undefined ? {} : { args: projectDynamicForOutbound(argumentsValue.args) }),
  });
}

export function projectMcpToolCallResultForOutbound(value: ToolResult): McpToolCallResult {
  const result = McpToolCallResultSchema.parse(value);
  if (result.success) {
    return McpToolCallResultSchema.parse({
      success: true,
      ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }),
    });
  }
  return McpToolCallResultSchema.parse({
    success: false,
    error: redactTextForOutbound(result.error),
    ...(result.data === undefined ? {} : { data: projectDynamicForOutbound(result.data) }),
  });
}

export function projectMcpReconcileResultForOutbound(value: ToolResult): McpReconcileResult {
  const result = McpReconcileResultSchema.parse(value);
  return McpReconcileResultSchema.parse({
    success: false,
    error: redactTextForOutbound(result.error),
    data: {
      persisted: result.data.persisted,
      reconciled: result.data.reconciled,
    },
  });
}
