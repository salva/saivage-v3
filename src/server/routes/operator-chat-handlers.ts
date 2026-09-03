import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { SaivageConfig } from '../../schemas/saivage-config.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { projectLiveToolInvocation } from '../../tools/tool-invocation-outbound.js';
import { ChatToolInvocationSchema } from '../../contracts/operator-api-chats.js';
import { ANALYST_TURN_BUSY_ERROR } from '../../contracts/operator-api-chats.js';
import { AnalystTurnBusyError } from '../../agents/analyst-api.js';

type ChatOperatorHandlerOptions = OperatorProjectContext & {
  runtimeApplication: RuntimeApplication;
  saivageConfig: SaivageConfig;
  restartPort?: RestartPort;
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
      if (response.restart?.status === 'scheduled') {
        const restartPort = options.restartPort;
        if (!restartPort)
          throw new Error('Scheduled restart response requires an application-owned restart port.');
        reply.raw.once('finish', () => {
          void restartPort.acknowledge();
        });
      }
      return result;
    },
  });
}
