import type { RuntimeActivationRecord } from '../schemas/index.js';
import { getSessionMessages } from './session-persistence.js';
import { applyRuntimeMutation } from '../runtime/mutations.js';
import type { SessionMessageLog } from './session-message-log.js';

export interface ActivationBarrierCompensationConfig {
  projectRoot: string;
  saivageDir: string;
  messageLog: SessionMessageLog;
  redactProviderErrorMessage: (message: unknown) => string;
}

export function compensateActivationBarrierThrow(
  config: ActivationBarrierCompensationConfig,
  sessionId: string,
  toolCallId: string,
  activation: RuntimeActivationRecord,
  error: unknown,
): void {
  const messages = getSessionMessages(config.saivageDir, sessionId);
  const alreadyResolved = messages.some(
    (message) =>
      (message.kind === 'tool_result' || message.kind === 'tool_error') &&
      message.tool_call_id === toolCallId,
  );
  if (!alreadyResolved) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    config.messageLog.append(sessionId, {
      role: 'tool',
      kind: 'tool_error',
      content: JSON.stringify({
        error: 'activation_barrier_dispatch_failed',
        message: config.redactProviderErrorMessage(errorMessage),
        child_card_id: activation.child_card_id,
        activation_id: activation.activation_id,
      }),
      tool: 'activate_card',
      tool_call_id: toolCallId,
    });
  }

  const now = new Date().toISOString();
  applyRuntimeMutation(config.projectRoot, {
    kind: 'completeActivation',
    childCardId: activation.child_card_id,
    outcome: 'failed',
    completedAt: now,
  });
}
