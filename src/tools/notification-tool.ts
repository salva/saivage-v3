import {
  toolFailed,
  toolSucceeded,
  type NotificationUrgency,
  type ToolActionOutcome,
} from '../contracts/index.js';
import { projectNotificationSubmission } from '../application/index.js';
import { queueNotification } from '../notifications/index.js';
import type { NotificationSubmissionPort } from '../runtime/runtime-api.js';

export interface QueueNotificationToolInput {
  readonly card_id: string;
  readonly kind: string;
  readonly body: string;
  readonly urgency: NotificationUrgency;
}

export async function submitNotificationTool(
  input: QueueNotificationToolInput,
  submitNotification: NotificationSubmissionPort,
  signal: AbortSignal,
): Promise<ToolActionOutcome> {
  const result = projectNotificationSubmission(
    await queueNotification(
      input.card_id,
      input.kind,
      input.body,
      input.urgency,
      submitNotification,
      signal,
    ),
    input.body,
  );
  return result.success ? toolSucceeded(result.data) : toolFailed(result.error, result.data);
}
