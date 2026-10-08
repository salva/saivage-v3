import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { McpToolInvocationNotInstalledError, McpInvokeError } from '../mcp/tool-api.js';
import {
  defineToolBinder,
  executedToolOutcome,
  MCP_RESULT_POLICY_TEMPLATE,
  type ToolBinder,
  type ToolExecutionResult,
} from './invocation.js';
import {
  toolFailed,
  throwIfPublicationOutcomeUnknown,
  McpToolCallArgumentsSchema,
  McpServerControlArgumentsSchema,
  McpToolsArgumentsSchema,
  toolSucceeded,
} from '../contracts/index.js';
import { certifiedPrefixEndpoints } from './response-packer.js';
import { redactTextWithStablePrefixesForOutbound } from '../redaction/index.js';
import { projectNativeMcpResult } from './mcp-native-result.js';
import { ImageInputError } from './image-input-error.js';
import { projectDynamicForOutbound } from '../redaction/index.js';
import { settledSuccessBytes } from './tool-result-settlement.js';

const MCP_ERROR_MAX_BYTES = 512;

function boundedMcpError(message: string): string {
  const stable = redactTextWithStablePrefixesForOutbound(message);
  const endpoints = certifiedPrefixEndpoints(stable, stable.text.length, MCP_ERROR_MAX_BYTES);
  return stable.text.slice(0, endpoints.at(-1)!);
}

export interface McpProviderContext {
  readonly projectRoot: string;
  readonly mcpToolInvocation: McpToolInvocationPort;
}

export const mcpToolBinders: readonly ToolBinder<McpProviderContext, any>[] = Object.freeze([
  defineToolBinder({
    name: 'mcp_server_control',
    description:
      'Start/install/discover or stop one configured MCP server. No topology changes. Start has one 180-second budget. Stop/cancel may lose the shared browser context; effects are not undone.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServerControlArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        const result =
          args.action === 'start'
            ? await ctx.mcpToolInvocation.startServer(args.serverName, signal)
            : await ctx.mcpToolInvocation.stopServer(args.serverName);
        signal.throwIfAborted();
        return executedToolOutcome('none', toolSucceeded(result));
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (signal.aborted && error === signal.reason) throw error;
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error.message)));
      }
    },
  }),
  defineToolBinder({
    name: 'mcp_tools',
    description:
      'Read currently ready MCP tool names, descriptions and exact input schemas. Optional toolName selects one exact tool. Does not grant invocation/control. Oversize discovery fails without truncating schemas.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolsArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        const catalog = ctx.mcpToolInvocation.getServerTools(args.serverName);
        if (!catalog)
          return executedToolOutcome('none', toolFailed('MCP server is stopped or not ready.'));
        const tools = args.toolName
          ? catalog.filter((tool) => tool.name === args.toolName)
          : catalog;
        if (args.toolName && !tools.length)
          return executedToolOutcome('none', toolFailed('MCP tool not found.'));
        const data = projectDynamicForOutbound({
          serverName: args.serverName,
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        if (Buffer.byteLength(settledSuccessBytes(data), 'utf8') > 1024 * 1024)
          return executedToolOutcome(
            'none',
            toolFailed(
              'MCP discovery exceeds 1 MiB; select an exact toolName. Oversize single schemas cannot be returned.',
            ),
          );
        return executedToolOutcome('none', toolSucceeded(data));
      } catch (error) {
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error.message)));
      }
    },
  }),
  defineToolBinder({
    name: 'mcp_tool_call',
    description:
      'Call a configured MCP tool. Preserves complete ordered native text/images and ordinary structured metadata. Native static PNG/JPEG/WebP snapshots use local max_dimension (default 1600; integer 1..16384 or original), not forwarded to the server. Wire <=48 MiB, aggregate image sources <=32 MiB, projected text/JSON <=1 MiB; oversize fails without truncation. Only use non-secret images: pixels cannot be redacted. Effects may occur even when a call fails.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolCallArgumentsSchema,
    executor: async (ctx, args, signal, invocation): Promise<ToolExecutionResult<'none'>> => {
      if (!invocation) throw new Error('MCP requires the owning tool invocation context.');
      let value: unknown;
      try {
        value = await ctx.mcpToolInvocation.invokeTool(
          args.serverName,
          args.toolName,
          args.args ?? {},
          { signal },
        );
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof McpToolInvocationNotInstalledError) throw error;
        if (signal.aborted && error === signal.reason) throw error;
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome(
          'none',
          toolFailed(boundedMcpError(error instanceof Error ? error.message : String(error))),
        );
      }
      let outcome;
      try {
        outcome = await projectNativeMcpResult(
          value,
          ctx.projectRoot,
          invocation.sessionId,
          signal,
          args.max_dimension,
        );
      } catch (error) {
        if (!(error instanceof ImageInputError)) throw error;
        signal.throwIfAborted();
        outcome = toolFailed(boundedMcpError(error.message));
      }
      return executedToolOutcome('none', outcome);
    },
  }),
]);
