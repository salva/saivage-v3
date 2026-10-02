import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/index.js';
import type { SaivageConfig } from '../../schemas/index.js';
import {
  ChatToolInvocationSchema,
  ANALYST_TURN_BUSY_ERROR,
  type RestartCapability,
} from '../../contracts/index.js';
import { projectLiveToolInvocation } from '../../tools/tool-api.js';
import {
  AnalystTurnBusyError,
  AnalystWorkspaceContextBudgetError,
} from '../../runtime/runtime-api.js';

type ChatOperatorHandlerOptions = OperatorProjectContext & {
  runtimeApplication: RuntimeApplication;
  saivageConfig: SaivageConfig;
  restartCapability: RestartCapability;
};

export function buildChatOperatorContractHandlers(options: ChatOperatorHandlerOptions) {
  return defineOperatorContractHandlers({
    'chats.get': () => ({ body: { session_id: options.runtimeApplication.analystSessionId } }),
    'chats.send': async ({ body, reply }) => {
      let response;
      try {
        response = await options.runtimeApplication.analystRuntime.submit({
          userContent: body.content,
          workspaceContext: body.workspaceContext,
        });
      } catch (error) {
        if (error instanceof AnalystTurnBusyError)
          return { statusCode: 409, body: ANALYST_TURN_BUSY_ERROR };
        if (error instanceof AnalystWorkspaceContextBudgetError)
          return {
            statusCode: 400,
            body: {
              error: 'ValidationError' as const,
              message: error.message,
              issues: [{ path: 'workspaceContext', message: error.message }],
            },
          };
        throw error;
      }
      const result = {
        body: {
          toolInvocations: (response.toolInvocations ?? []).map((invocation) => {
            const projected = projectLiveToolInvocation({
              shape: 'complete',
              identity: {
                sessionId: response.sessionId,
                sourceInputId: invocation.sourceInputId,
                toolCallId: invocation.toolCallId,
                toolName: invocation.tool,
              },
              arguments: invocation.params,
              result: invocation.result,
            });
            return ChatToolInvocationSchema.parse({
              tool: projected.identity.toolName,
              params: projected.arguments,
              result: projected.result,
            });
          }),
          restart: response.restart,
        },
      };
      if (response.restart?.status === 'scheduled' && options.restartCapability.available) {
        const restartPort = options.restartCapability.port;
        reply.raw.once('finish', () => {
          void restartPort.acknowledge();
        });
      }
      return result;
    },
  });
}
