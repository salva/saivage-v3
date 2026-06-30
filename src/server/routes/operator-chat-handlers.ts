import { getAnalystHandler } from '../../agents/analyst-api.js';
import { GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId } from '../../agents/session-ids.js';
import { AgentOperatorReadModelService } from '../../application/read-models/index.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import type {
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRestartContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';

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

type ChatOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorRestartContext;

export function buildChatOperatorContractHandlers(options: ChatOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const agentReadModel = new AgentOperatorReadModelService(projectRoot);

  return {
    'chats.list': () => {
      const sessions = agentReadModel.listSessions().sessions.filter((session) => session.role === 'analyst' && session.id.startsWith('analyst:'));
      return { body: { sessions } };
    },
    'chats.get': ({ params }) => {
      const sessionId = (params as unknown as { sessionId: string }).sessionId;
      if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid session ID format.', sessionId } };
      if (sessionId !== GLOBAL_ANALYST_SESSION_ID) return { statusCode: 404, body: { error: 'Only the canonical analyst chat is available.', sessionId } };
      const response = agentReadModel.getConversation(sessionId);
      if (response.statusCode === 404) return { body: { sessionId: GLOBAL_ANALYST_SESSION_ID, entries: [] } };
      if (response.statusCode) return response;
      if (!('entries' in response.body)) return response;
      return { body: { sessionId: GLOBAL_ANALYST_SESSION_ID, entries: response.body.entries } };
    },
    'chats.send': async ({ params, body }) => {
      const sessionId = (params as unknown as { sessionId: string }).sessionId;
      const requestBody = body as { content?: string; workspaceContext?: unknown };
      if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid session ID format.', sessionId } };
      if (sessionId !== GLOBAL_ANALYST_SESSION_ID) return { statusCode: 404, body: { error: 'Only the canonical analyst chat is available.', sessionId } };
      if (!requestBody.content) return { statusCode: 400, body: { error: 'Message content is required' } };
      let workspaceContext: ChatWorkspaceContext | undefined;
      if (requestBody.workspaceContext !== undefined) {
        const validation = validateWorkspaceContext(requestBody.workspaceContext);
        if (!validation.ok) return { statusCode: 400, body: { error: validation.error } };
        workspaceContext = validation.value;
      }
      try {
        if (!options.runtimeApplication) return { statusCode: 503, body: { error: 'Runtime application unavailable.' } };
        const handler = getAnalystHandler(projectRoot, { runtimeDeps: options.runtimeApplication.analystDeps, surface: 'web-chat', requestServerRestart: options.requestServerRestart });
        const response = await handler.handleMessage(GLOBAL_ANALYST_SESSION_ID, requestBody.content, workspaceContext);
        const message = response.message;
        return {
          body: {
            sessionId: response.sessionId,
            message: {
              ...message,
              id: message.id,
              role: 'assistant' as const,
              kind: 'text' as const,
              content: message.content,
              timestamp: message.timestamp,
            },
            toolInvocations: response.toolInvocations ?? [],
          },
        };
      } catch (err) {
        return { statusCode: 500, body: { error: 'Failed to process chat message', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) } };
      }
    },
  };
}
