import {
  McpToolCallArgumentsSchema,
  type McpToolCallArguments,
} from '../contracts/mcp-invocation.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';

export function projectMcpToolCallArgumentsForOutbound(value: McpToolCallArguments): McpToolCallArguments {
  const argumentsValue = McpToolCallArgumentsSchema.parse(value);
  return McpToolCallArgumentsSchema.parse({
    serverName: argumentsValue.serverName,
    toolName: argumentsValue.toolName,
    ...(argumentsValue.args === undefined ? {} : { args: projectDynamicForOutbound(argumentsValue.args) }),
  });
}
