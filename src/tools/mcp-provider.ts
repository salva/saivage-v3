import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { McpToolInvocationNotInstalledError, McpInvokeError } from '../mcp/tool-api.js';
import type { NativeMcpResult } from '../mcp/tool-api.js';
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
  McpCatalogRefreshArgumentsSchema,
  McpServerRegisterArgumentsSchema,
  McpServerReplaceArgumentsSchema,
  McpServerUnregisterArgumentsSchema,
  McpServersArgumentsSchema,
  toolSucceeded,
} from '../contracts/index.js';
import { certifiedPrefixEndpoints } from './response-packer.js';
import { redactTextWithStablePrefixesForOutbound } from '../redaction/index.js';
import { projectNativeMcpResult } from './mcp-native-result.js';
import { ImageInputError } from './image-input-error.js';
import { projectDynamicForOutbound } from '../redaction/index.js';
import { settledSuccessBytes } from './tool-result-settlement.js';
import { projectOutboundSource } from '../observability/index.js';

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
    name: 'mcp_server_replace',
    description:
      'Wholly replace an existing agent-owned MCP connection only when known stopped. Stop and join a used server first; start and discover separately afterward. Omitted connection fields are removed. Replacement never launches or autostarts a server and grants no call/control permission.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServerReplaceArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        return executedToolOutcome(
          'none',
          toolSucceeded(ctx.mcpToolInvocation.replaceServer(args.serverName, args.connection)),
        );
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error.message)));
      }
    },
  }),
  defineToolBinder({
    name: 'mcp_server_register',
    description:
      'Persist a new agent-owned MCP connection without launching it. Explicit start is separate; dynamic connections never autostart. Does not grant invocation permission.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServerRegisterArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        return executedToolOutcome(
          'none',
          toolSucceeded(ctx.mcpToolInvocation.registerServer(args.serverName, args.connection)),
        );
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error.message)));
      }
    },
  }),
  defineToolBinder({
    name: 'mcp_server_unregister',
    description:
      'Remove one agent-owned MCP definition and contain its exact connection. Does not remove operator YAML. A containment failure leaves the definition absent and old owner blocking reuse.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServerUnregisterArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        const result = await ctx.mcpToolInvocation.unregisterServer(args.serverName);
        return executedToolOutcome('none', toolSucceeded(result));
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (!(error instanceof McpInvokeError)) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error.message)));
      }
    },
  }),
  defineToolBinder({
    name: 'mcp_servers',
    description:
      'Observe safe MCP definitions and retained connection owners, including starting, stopped and containment blockers. Optional serverName selects one exact name. Process IDs are correlations, not wait/kill authority.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServersArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      const statuses = args.serverName
        ? [ctx.mcpToolInvocation.getServerStatus(args.serverName)].filter((s) => s !== undefined)
        : ctx.mcpToolInvocation.getStatus();
      const data = projectDynamicForOutbound({
        servers: statuses.map(
          ({
            name,
            transport,
            status,
            definitionSource,
            containmentFailed,
            processId,
            bindingId,
            tools_count,
          }) => ({
            name,
            transport,
            status,
            definitionSource,
            containmentFailed,
            processId,
            bindingId,
            toolCount: tools_count ?? 0,
          }),
        ),
      });
      if (Buffer.byteLength(settledSuccessBytes(data), 'utf8') > 1024 * 1024)
        return executedToolOutcome(
          'none',
          toolFailed('MCP observation exceeds 1 MiB; select an exact serverName.'),
        );
      return executedToolOutcome('none', toolSucceeded(data));
    },
  }),
  defineToolBinder({
    name: 'mcp_server_control',
    description:
      'Start/install/discover, stop, or restart one operator or agent-defined MCP server. Restart requires a retained owner: stop and join it before a fresh start/discovery. This sequence is not atomic and never replays work. Start has one 180-second budget. Stop/restart/cancel may lose the shared browser context; effects are not undone.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpServerControlArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal, invocation) => {
      signal.throwIfAborted();
      try {
        const options = {
          signal,
          observationSource: invocation
            ? projectOutboundSource(invocation.sessionId, invocation.sourceInputId)
            : undefined,
        };
        let result;
        switch (args.action) {
          case 'start':
            result = await ctx.mcpToolInvocation.startServer(args.serverName, options);
            break;
          case 'stop':
            result = await ctx.mcpToolInvocation.stopServer(args.serverName);
            break;
          case 'restart':
            result = await ctx.mcpToolInvocation.restartServer(args.serverName, options);
            break;
          default: {
            const unexpected: never = args.action;
            throw new Error(`Unexpected MCP lifecycle action: ${unexpected}`);
          }
        }
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
      'Read currently ready MCP tool names, descriptions, exact input schemas and connection bindingId/catalogId required for calls. Optional toolName selects one exact tool. This observes the last successful catalog; it does not refresh it or grant invocation/control. Oversize discovery fails without truncating schemas.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolsArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal) => {
      signal.throwIfAborted();
      try {
        const catalog = ctx.mcpToolInvocation.getServerCatalog(args.serverName);
        if (!catalog)
          return executedToolOutcome('none', toolFailed('MCP server is stopped or not ready.'));
        const tools = args.toolName
          ? catalog.tools.filter((tool) => tool.name === args.toolName)
          : catalog.tools;
        if (args.toolName && !tools.length)
          return executedToolOutcome('none', toolFailed('MCP tool not found.'));
        for (const tool of tools) {
          if (
            JSON.stringify(projectDynamicForOutbound(tool.inputSchema)) !==
            JSON.stringify(tool.inputSchema)
          )
            return executedToolOutcome(
              'none',
              toolFailed('MCP input schema cannot be safely disclosed without alteration.'),
            );
        }
        const data = projectDynamicForOutbound({
          serverName: args.serverName,
          bindingId: catalog.bindingId,
          catalogId: catalog.catalogId,
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
    name: 'mcp_catalog_refresh',
    description:
      'Explicitly re-list one ready MCP server on its observed connection without restarting it. Publishes a complete new catalog identity, even for unchanged tools; discover exact schemas again before calling. One 30-second budget includes queue wait and pagination. Concurrent refresh fails busy. Failure may retain the last successful observation or close an interrupted stdio connection; no target continuity or replay is guaranteed.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpCatalogRefreshArgumentsSchema,
    executor: async (ctx: McpProviderContext, args, signal, invocation) => {
      signal.throwIfAborted();
      try {
        const result = await ctx.mcpToolInvocation.refreshServerCatalog(
          args.serverName,
          args.bindingId,
          {
            signal,
            observationSource: invocation
              ? projectOutboundSource(invocation.sessionId, invocation.sourceInputId)
              : undefined,
          },
        );
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
    name: 'mcp_tool_call',
    description:
      'Call a ready MCP tool using its discovery bindingId and catalogId. Stale identities fail before dispatch; discover again and author a new call, never automatically replay. Preserves complete ordered native text/images and ordinary structured metadata. Native static PNG/JPEG/WebP snapshots use local max_dimension (default 1600; integer 1..16384 or original), not forwarded to the server. Wire <=48 MiB, aggregate image sources <=32 MiB, projected text/JSON <=1 MiB; oversize fails without truncation. Only use non-secret images: pixels cannot be redacted. Effects may occur even when a call fails.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolCallArgumentsSchema,
    executor: async (ctx, args, signal, invocation): Promise<ToolExecutionResult<'none'>> => {
      if (!invocation) throw new Error('MCP requires the owning tool invocation context.');
      let value: NativeMcpResult;
      try {
        value = await ctx.mcpToolInvocation.invokeTool(
          args.serverName,
          args.bindingId,
          args.catalogId,
          args.toolName,
          args.args ?? {},
          {
            signal,
            observationSource: projectOutboundSource(
              invocation.sessionId,
              invocation.sourceInputId,
            ),
          },
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
