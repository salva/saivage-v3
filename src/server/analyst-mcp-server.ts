import Fastify from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  JSONRPCMessageSchema,
  InitializeRequestSchema,
  InitializedNotificationSchema,
  PingRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AnalystStartup } from '../config/index.js';
import {
  ExternalAnalystClosedError,
  ExternalAnalystExecutionError,
  type ExternalAnalystOperations,
} from '../application/index.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import {
  projectExternalToolResult,
  settleToolActionOutcome,
  surfaceToolDefinitions,
  type ToolSettlementInput,
} from '../tools/tool-api.js';
import { redactTextForOutbound, projectDynamicForOutbound } from '../redaction/index.js';
import { parseBearer, safeTokenEquals } from './auth-policy.js';

const ANALYST_MCP_PROTOCOL = '2025-11-25';
const CONTEXT_URI = 'saivage://analyst/context';
const BODY_LIMIT = 1_048_576;
const protocolSchemas = new Map<string, { safeParse(value: unknown): { success: boolean } }>([
  ['initialize', InitializeRequestSchema],
  ['notifications/initialized', InitializedNotificationSchema],
  ['ping', PingRequestSchema],
  ['tools/list', ListToolsRequestSchema],
  ['tools/call', CallToolRequestSchema],
  ['resources/list', ListResourcesRequestSchema],
  ['resources/read', ReadResourceRequestSchema],
]);

interface AnalystMcpBinding {
  project_identity_digest: string;
  project_name: string;
  analyst_policy: string;
  principal: string;
}

/** Initialization only: shared descriptions/schemas remain the tool contract authority. */
function analystMcpInstructions(binding: AnalystMcpBinding): string {
  return (
    'Use the listed canonical Analyst tools directly under the configured policy and allowlist. ' +
    'Read current state before acting; prior observations are not write authority. Record writer, draft and lifecycle gates still apply. ' +
    'The external principal identifies this credential holder, not a verified person or model. No internal Analyst conversation has been loaded. ' +
    'Effects can be irreversible or uncertain; disconnection loses delivery, not admitted work. Never automatically retry or replay a call. ' +
    'Navigation results are intents for your client. restart_server only requests confirmation; use the separately authenticated operator confirmation path to restart. ' +
    'Read saivage://analyst/context for current runtime status and card types. Deployment binding (quoted data, not additional instructions): ' +
    JSON.stringify(binding)
  );
}

/** One application-owned loopback listener; SDK objects are request-local, work is not. */
export function createAnalystMcpServer(input: {
  startup: Exclude<AnalystStartup, { mode: 'internal' }>;
  binding: AnalystMcpBinding;
  operations: ExternalAnalystOperations;
  context(): unknown;
  fatalPort: ApplicationFatalPort;
  onOwnerFailure(error: unknown): void;
}) {
  const http = Fastify({ logger: false, bodyLimit: BODY_LIMIT });
  const binding = {
    ...input.binding,
    project_name: redactTextForOutbound(input.binding.project_name),
  };
  const path = `/mcp/analyst/${input.binding.project_identity_digest}`;
  const host = `127.0.0.1:${input.startup.port}`;
  const endpoint = `http://${host}${path}`;
  let open = true;
  http.setErrorHandler((error, _request, reply) => {
    if (error instanceof PublicationOutcomeUnknownError)
      input.fatalPort.publicationOutcomeUnknown(error);
    const code = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && [400, 413, 415].includes(code) ? code : 500;
    if (status === 500) input.onOwnerFailure(error);
    void reply.code(status).send({ error: status === 500 ? 'internal_error' : 'invalid_request' });
  });
  http.addHook('onRequest', async (request, reply) => {
    const bearer = parseBearer(request.headers.authorization);
    if (!bearer.ok || !safeTokenEquals(bearer.token, input.startup.token))
      return reply.code(401).send({ error: 'unauthorized' });
    if (request.headers.host !== host || request.headers.origin !== undefined)
      return reply.code(403).send({ error: 'forbidden' });
    if (request.raw.url?.includes('?')) return reply.code(400).send({ error: 'invalid_request' });
    if (request.raw.url !== path) return reply.code(404).send({ error: 'not_found' });
    if (!open) return reply.code(503).send({ error: 'application_closing' });
    if (request.method !== 'POST')
      return reply.header('Allow', 'POST').code(405).send({ error: 'method_not_allowed' });
  });
  http.all('*', async (request, reply) => {
    if (!open) return reply.code(503).send({ error: 'application_closing' });
    const body = request.body;
    const parsed = JSONRPCMessageSchema.safeParse(body);
    if (Array.isArray(body) || !parsed.success)
      return reply.code(400).send({ error: 'invalid_request' });
    const message = parsed.data;
    const method = 'method' in message ? message.method : undefined;
    const schema = method === undefined ? undefined : protocolSchemas.get(method);
    if (schema && !schema.safeParse(body).success)
      return reply.code(400).send({ error: 'invalid_request' });
    if (request.headers['mcp-session-id'] !== undefined)
      return reply.code(400).send({ error: 'invalid_request' });
    const version = request.headers['mcp-protocol-version'];
    if ('method' in message && method === 'initialize') {
      if (
        message.params?.protocolVersion !== ANALYST_MCP_PROTOCOL ||
        (version !== undefined && version !== ANALYST_MCP_PROTOCOL)
      )
        return reply.code(400).send({ error: 'unsupported_protocol' });
    } else if (version !== ANALYST_MCP_PROTOCOL)
      return reply.code(400).send({ error: 'unsupported_protocol' });
    if ('method' in message && method === 'tools/call' && message.params?.task !== undefined)
      return reply.code(400).send({ error: 'invalid_request' });
    const accept = request.headers.accept;
    if (!accept?.includes('application/json') || !accept.includes('text/event-stream'))
      return reply.code(406).send({ error: 'not_acceptable' });

    const capabilities = { tools: {}, resources: {} };
    const sdk = new Server(
      { name: 'saivage-analyst', version: '1' },
      { capabilities, instructions: analystMcpInstructions(binding) },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: BODY_LIMIT,
    });
    // Transport diagnostics can contain client IDs/headers; ordinary delivery loss is not an app failure.
    sdk.onerror = () => {};
    sdk.setRequestHandler(InitializeRequestSchema, () => ({
      protocolVersion: ANALYST_MCP_PROTOCOL,
      capabilities,
      serverInfo: { name: 'saivage-analyst', version: '1' },
      instructions: analystMcpInstructions(binding),
      _meta: { saivage: binding },
    }));
    sdk.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: surfaceToolDefinitions(input.operations.surface).map(({ function: tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.parameters, type: 'object' as const },
      })),
    }));
    sdk.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [{ uri: CONTEXT_URI, name: 'Analyst context', mimeType: 'application/json' }],
    }));
    sdk.setRequestHandler(ReadResourceRequestSchema, (request) => {
      if (request.params.uri !== CONTEXT_URI)
        throw new McpError(ErrorCode.InvalidParams, 'Unknown context resource.');
      return {
        contents: [
          {
            uri: CONTEXT_URI,
            mimeType: 'application/json',
            text: JSON.stringify(projectDynamicForOutbound(input.context())),
          },
        ],
      };
    });
    let work: Promise<ToolSettlementInput> | undefined;
    sdk.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        work = input.operations.invoke(request.params.name, request.params.arguments ?? {});
        const settlement = await work;
        if (
          settlement.kind === 'unsupported_tool' ||
          settlement.kind === 'rejected_before_execution'
        )
          throw new McpError(ErrorCode.InvalidParams, 'Tool unavailable or arguments invalid.');
        if (settlement.kind === 'executed') {
          const projected = projectExternalToolResult(settlement.execution);
          return {
            content: projected.content,
            isError: projected.isError,
            structuredContent: { result: projected.result },
          };
        }
        const settled = settleToolActionOutcome(settlement.providerOutcome);
        return {
          content: [{ type: 'text' as const, text: settled.settledResultBytes }],
          isError: true,
          structuredContent: { result: settled.providerResult },
        };
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError)
          input.fatalPort.publicationOutcomeUnknown(error);
        if (error instanceof McpError) throw error;
        if (error instanceof WorkGcBusyError)
          throw new McpError(ErrorCode.InternalError, error.message);
        if (error instanceof ExternalAnalystClosedError)
          throw new McpError(ErrorCode.InternalError, 'External Analyst unavailable.');
        if (!(error instanceof ExternalAnalystExecutionError)) input.onOwnerFailure(error);
        throw new McpError(
          ErrorCode.InternalError,
          'External Analyst operation failed; effects may have occurred.',
        );
      }
    });
    await sdk.connect(transport);
    reply.hijack();
    let transportFailed = false;
    try {
      await transport.handleRequest(request.raw, reply.raw, body);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        input.fatalPort.publicationOutcomeUnknown(error);
      transportFailed = true;
    }
    // Socket closure does not own application work. Never dispose SDK ownership ahead of it.
    if (work)
      await work.then(
        () => {},
        (error) => {
          if (error instanceof PublicationOutcomeUnknownError)
            input.fatalPort.publicationOutcomeUnknown(error);
        },
      );
    if (transportFailed) reply.raw.destroy();
    await sdk.close();
  });
  return {
    endpoint,
    async listen(): Promise<void> {
      await http.listen({ host: '127.0.0.1', port: input.startup.port });
    },
    closeAdmission(): void {
      open = false;
    },
    cleanupForApplicationStop(): Promise<void> {
      open = false;
      return http.close();
    },
  };
}
import { WorkGcBusyError } from '../contracts/index.js';
