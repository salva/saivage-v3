import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/index.js';
import { GLOBAL_ANALYST_SESSION_ID, getAnalystHandler } from '../../agents/index.js';
import { operatorApiContracts } from '../../contracts/index.js';
import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
  ChatReadModelService,
  DebugReadModelService,
  WorkspaceFileReadModelService,
  isSafeChatSessionId,
} from '../../application/read-models/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/index.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import { buildServerAvailability } from '../availability.js';
import { ContractRuntime, type ContractHandler } from '../contract-runtime.js';

interface ChatWorkspaceContext {
  view: string | null;
  entityId: string | null;
  refinement: Record<string, string> | null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function validateWorkspaceContext(value: unknown): { ok: true; value: ChatWorkspaceContext } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'workspaceContext must be an object.' };
  const ctx = value as Record<string, unknown>;
  if (!(ctx.view === null || typeof ctx.view === 'string')) return { ok: false, error: 'workspaceContext.view must be a string or null.' };
  if (!(ctx.entityId === null || typeof ctx.entityId === 'string')) return { ok: false, error: 'workspaceContext.entityId must be a string or null.' };
  if (!(ctx.refinement === null || isStringRecord(ctx.refinement))) return { ok: false, error: 'workspaceContext.refinement must be an object with string values or null.' };
  return { ok: true, value: { view: ctx.view, entityId: ctx.entityId, refinement: ctx.refinement } as ChatWorkspaceContext };
}

export function registerOperatorContractRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
  activeRuntimeProvider?: () => ActiveRuntime | undefined;
  mcpStatusProvider?: () => McpStatusProvider | undefined;
  mcpToolsProvider?: () => McpToolsReadModelProvider | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
  requestServerRestart?: () => Promise<void>;
}): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const cardsReadModel = new CardsReadModelService(projectRoot);
  const chatReadModel = new ChatReadModelService(projectRoot);
  const fileReadModel = new WorkspaceFileReadModelService(projectRoot);
  const debugReadModel = new DebugReadModelService(projectRoot);
  const getActiveRuntime = () => options.activeRuntimeProvider?.() ?? options.activeRuntime;

  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => cardsReadModel.getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => cardsReadModel.listCards(),
    'cards.get': ({ params }) => cardsReadModel.getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => cardsReadModel.listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return cardsReadModel.getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => cardsReadModel.diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, activeRuntime: getActiveRuntime(), serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot) }),
    'mcp.status': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const provider = options.mcpStatusProvider?.();
      return { body: { servers: provider?.getStatus() ?? [], ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'mcp.tools': () => ({ body: options.mcpToolsProvider?.()?.getToolsReadModel() ?? { tools: [], servers: [], invocationStats: {}, serverDetails: [] } }),
    'chats.list': () => chatReadModel.listSessions(),
    'chats.get': ({ params }) => chatReadModel.getMessages((params as unknown as { sessionId: string }).sessionId),
    'chats.send': async ({ params, body }) => {
      const sessionId = (params as unknown as { sessionId: string }).sessionId;
      const requestBody = body as { content?: string; workspaceContext?: unknown };
      if (!isSafeChatSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid session ID format.', sessionId } };
      if (sessionId !== GLOBAL_ANALYST_SESSION_ID) return { statusCode: 404, body: { error: 'Only the canonical analyst chat is available.', sessionId } };
      if (!requestBody.content) return { statusCode: 400, body: { error: 'Message content is required' } };
      let workspaceContext: ChatWorkspaceContext | undefined;
      if (requestBody.workspaceContext !== undefined) {
        const validation = validateWorkspaceContext(requestBody.workspaceContext);
        if (!validation.ok) return { statusCode: 400, body: { error: validation.error } };
        workspaceContext = validation.value;
      }
      try {
        const handler = getAnalystHandler(projectRoot, { activeRuntime: getActiveRuntime(), surface: 'web-chat', requestServerRestart: options.requestServerRestart });
        const response = await handler.handleMessage(GLOBAL_ANALYST_SESSION_ID, requestBody.content, workspaceContext);
        return { body: { sessionId: response.sessionId, message: response.message, toolInvocations: response.toolInvocations ?? [] } };
      } catch (err) {
        return { statusCode: 500, body: { error: 'Failed to process chat message', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) } };
      }
    },
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => ({ body: debugReadModel.getState() }),
    'debug.errors': () => ({ body: debugReadModel.getErrors() }),
    'debug.timeline': () => ({ body: debugReadModel.getTimeline() }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
