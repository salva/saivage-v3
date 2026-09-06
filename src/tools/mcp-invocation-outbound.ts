import {
  McpToolCallArgumentsSchema,
  type McpToolCallArguments,
} from '../contracts/mcp-invocation.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import type { ToolResult } from '../contracts/tool-result.js';
import { projectHistoricalToolResultForOutbound } from './tool-result-settlement.js';

export function projectMcpToolCallArgumentsForOutbound(value: McpToolCallArguments): McpToolCallArguments {
  const argumentsValue = McpToolCallArgumentsSchema.parse(value);
  return McpToolCallArgumentsSchema.parse({
    serverName: argumentsValue.serverName,
    toolName: argumentsValue.toolName,
    ...(argumentsValue.args === undefined ? {} : { args: projectDynamicForOutbound(argumentsValue.args) }),
  });
}

export function projectMcpToolCallResultForOutbound(value: ToolResult): ToolResult {
  return projectHistoricalToolResultForOutbound(value);
}

export function projectMcpReconcileResultForOutbound(value: ToolResult): ToolResult {
  return projectHistoricalToolResultForOutbound(value);
}
