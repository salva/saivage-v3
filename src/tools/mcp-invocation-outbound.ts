import { McpToolCallArgumentsSchema, type McpToolCallArguments } from '../contracts/index.js';
import { projectDynamicForOutbound } from '../redaction/index.js';

export function projectMcpToolCallArgumentsForOutbound(
  value: McpToolCallArguments,
): McpToolCallArguments {
  const argumentsValue = McpToolCallArgumentsSchema.parse(value);
  return McpToolCallArgumentsSchema.parse({
    serverName: argumentsValue.serverName,
    toolName: argumentsValue.toolName,
    ...(argumentsValue.max_dimension === undefined
      ? {}
      : { max_dimension: argumentsValue.max_dimension }),
    ...(argumentsValue.args === undefined
      ? {}
      : { args: projectDynamicForOutbound(argumentsValue.args) }),
  });
}
