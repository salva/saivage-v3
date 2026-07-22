import { GLOBAL_ANALYST_SESSION_ID } from '../../schemas/index.js';
import { AgentOperatorReadModelService } from '../../application/read-models/index.js';
import type {
  OperatorProjectContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { SaivageConfig } from '../../agents/config-api.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { redactForOutbound } from '../../redaction/index.js';
import { ChatToolInvocationSchema } from '../../contracts/operator-api-chats.js';

type ChatOperatorHandlerOptions = OperatorProjectContext & {
  runtimeApplication: RuntimeApplication;
  saivageConfig: SaivageConfig;
  restartPort?: RestartPort;
};

export function buildChatOperatorContractHandlers(options: ChatOperatorHandlerOptions) {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    return new AgentOperatorReadModelService(projectRoot, () => options.runtimeApplication.captureExecutingLlmSnapshots());
  };

  return defineOperatorContractHandlers({
    'chats.get': () => {
      const response = agentReadModel().getConversation(GLOBAL_ANALYST_SESSION_ID);
      if (response.statusCode === 404) return { body: { session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } } };
      if (response.statusCode === 400) return response;
      const conversation = response.body;
      if (conversation.session.role !== 'analyst') throw new Error('Global Analyst conversation projected a non-Analyst session.');
      return { body: { session: conversation.session, entries: conversation.entries, activity_status: conversation.activity_status } };
    },
    'chats.send': async ({ body, reply }) => {
      if (!body.content) return { statusCode: 400, body: { error: 'Message content is required' } };
      const response = await options.runtimeApplication.analystRuntime.submit({ userContent: body.content, workspaceContext: body.workspaceContext });
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
            if (projected.shape !== 'complete') throw new Error('Live chat invocation projected to a non-complete shape.');
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
        if (!restartPort) throw new Error('Scheduled restart response requires an application-owned restart port.');
        reply.raw.once('finish', () => { void restartPort.acknowledge(); });
      }
      return result;
    },
  });
}
