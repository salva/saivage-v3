import { McpToolCallArgumentsSchema, type McpToolCallArguments } from '../contracts/index.js';
import {
  projectDynamicForOutbound,
  redactUrl,
  SECRET_REDACTION_PLACEHOLDER,
} from '../redaction/index.js';

// Also used for rejected inputs: env values must never depend on secret-key heuristics.
export function projectMcpRegistrationForOutbound(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return projectDynamicForOutbound(value);
  const input = value as Record<string, unknown>;
  const connection = input['connection'];
  if (!connection || typeof connection !== 'object' || Array.isArray(connection))
    return projectDynamicForOutbound(value);
  const fields = connection as Record<string, unknown>;
  return projectDynamicForOutbound({
    ...input,
    connection: {
      ...fields,
      ...(fields['env'] === undefined
        ? {}
        : {
            env:
              fields['env'] && typeof fields['env'] === 'object' && !Array.isArray(fields['env'])
                ? Object.fromEntries(
                    Object.keys(fields['env']).map((key) => [key, SECRET_REDACTION_PLACEHOLDER]),
                  )
                : SECRET_REDACTION_PLACEHOLDER,
          }),
      ...(typeof fields['url'] === 'string' ? { url: redactUrl(fields['url']) } : {}),
    },
  });
}

export function projectMcpToolCallArgumentsForOutbound(
  value: McpToolCallArguments,
): McpToolCallArguments {
  const argumentsValue = McpToolCallArgumentsSchema.parse(value);
  return McpToolCallArgumentsSchema.parse({
    serverName: argumentsValue.serverName,
    bindingId: argumentsValue.bindingId,
    toolName: argumentsValue.toolName,
    ...(argumentsValue.max_dimension === undefined
      ? {}
      : { max_dimension: argumentsValue.max_dimension }),
    ...(argumentsValue.args === undefined
      ? {}
      : { args: projectDynamicForOutbound(argumentsValue.args) }),
  });
}
