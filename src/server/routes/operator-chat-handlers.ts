import { GLOBAL_ANALYST_SESSION_ID } from '../../schemas/index.js';
import { AgentOperatorReadModelService } from '../../application/read-models/index.js';
import { redactOperatorErrorMessage } from '../../workspace/index.js';
import type {
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorConfigContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import type { OperatorCardServiceContext } from './operator-handler-context.js';

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

type ChatOperatorHandlerOptions = OperatorProjectContext & OperatorRuntimeProviderContext & OperatorCardServiceContext & Pick<OperatorConfigContext, 'saivageConfig'>;

export function buildChatOperatorContractHandlers(options: ChatOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    if (!options.runtimeApplication) throw new Error('Chat read operations require the runtime application.');
    return new AgentOperatorReadModelService(projectRoot, () => options.runtimeApplication!.captureExecutingLlmSnapshots());
  };

  return {
    'chats.list': () => {
      const sessions = agentReadModel().listSessions().sessions.filter((session) => session.id === GLOBAL_ANALYST_SESSION_ID);
      return { body: { sessions } };
    },
    'chats.get': () => {
      const response = agentReadModel().getConversation(GLOBAL_ANALYST_SESSION_ID);
      if (response.statusCode === 404) return { body: { session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } } };
      if (response.statusCode) return response;
      return response;
    },
    'chats.send': async ({ body, reply }) => {
      const requestBody = body as { content?: string; workspaceContext?: unknown };
      if (!requestBody.content) return { statusCode: 400, body: { error: 'Message content is required' } };
      let workspaceContext: ChatWorkspaceContext | undefined;
      if (requestBody.workspaceContext !== undefined) {
        const validation = validateWorkspaceContext(requestBody.workspaceContext);
        if (!validation.ok) return { statusCode: 400, body: { error: validation.error } };
        workspaceContext = validation.value;
      }
      try {
        if (!options.runtimeApplication) return { statusCode: 503, body: { error: 'Runtime application unavailable.' } };
        if (!options.saivageConfig) return { statusCode: 503, body: { error: 'Runtime configuration unavailable.' } };
        const response = await options.runtimeApplication.analystRuntime.submit({ userContent: requestBody.content, workspaceContext, actor: 'analyst', surface: 'web-chat' });
        const result = {
          body: {
            sessionId: response.sessionId,
            toolInvocations: response.toolInvocations ?? [],
            restart: response.restart,
          },
        };
        if (response.restart?.status === 'scheduled') {
          const restartPort = options.restartPort;
          if (!restartPort) throw new Error('Scheduled restart response requires an application-owned restart port.');
          reply.raw.once('finish', () => { void restartPort.acknowledge(); });
        }
        return result;
      } catch (err) {
        return { statusCode: 500, body: { error: 'Failed to process chat message', message: redactOperatorErrorMessage(err instanceof Error ? err.message : String(err), projectRoot) } };
      }
    },
  };
}
