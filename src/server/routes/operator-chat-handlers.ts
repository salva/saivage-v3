import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { SaivageConfig } from '../../schemas/saivage-config.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { redactForOutbound } from '../../redaction/index.js';
import { ChatToolInvocationSchema } from '../../contracts/operator-api-chats.js';

type ChatOperatorHandlerOptions = OperatorProjectContext & {
  runtimeApplication: RuntimeApplication;
  saivageConfig: SaivageConfig;
  restartPort?: RestartPort;
};

export function buildChatOperatorContractHandlers(options: ChatOperatorHandlerOptions) {
  return defineOperatorContractHandlers({
    'chats.get': () => ({ body: { session_id: options.runtimeApplication.analystSessionId } }),
    'chats.send': async ({ body, reply }) => {
      if (!body.content) return { statusCode: 400, body: { error: 'Message content is required' } };
      const response = await options.runtimeApplication.analystRuntime.submit({
        userContent: body.content,
        workspaceContext: body.workspaceContext,
      });
      const result = {
        body: {
          sessionId: response.sessionId,
          toolInvocations: (response.toolInvocations ?? []).map((invocation) => {
            const projected = redactForOutbound({
              source: 'tool-invocation',
              value: {
                shape: 'complete',
                identity: {
                  sessionId: response.sessionId,
                  sourceInputId: invocation.sourceInputId,
                  toolCallId: invocation.toolCallId,
                  toolName: invocation.tool,
                },
                arguments: invocation.params,
                result: invocation.result,
              },
            });
            if (projected.shape !== 'complete')
              throw new Error('Live chat invocation projected to a non-complete shape.');
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
