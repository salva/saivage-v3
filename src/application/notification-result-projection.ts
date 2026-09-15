import { redactTextForOutbound } from '../redaction/index.js';
import type { NotificationSubmissionResult } from '../runtime/runtime-api.js';

type ProjectedNotificationSubmission =
  | Readonly<{ success: true; data: Record<string, unknown> }>
  | Readonly<{ success: false; error: string; data: Record<string, unknown> }>;

export function projectNotificationSubmission(
  result: NotificationSubmissionResult,
  body: string,
): ProjectedNotificationSubmission {
  if (result.queued) {
    return {
      success: true,
      data: {
        queued: true,
        card_id: result.cardId,
        notification_id: result.notificationId,
        body: redactTextForOutbound(body),
        interruption: result.interruption,
      },
    };
  }
  switch (result.reason) {
    case 'missing_card':
      return failure(`Card '${result.cardId}' not found.`, result);
    case 'terminal_card':
      return failure(`Cannot queue notification for terminal card '${result.cardId}' in status '${result.status}'.`, result);
    case 'activation_closed':
      return failure(`Cannot queue notification for card '${result.cardId}': its current activation is closed to new notifications.`, result);
    case 'planning_ineligible':
      return failure(`Card '${result.cardId}' is not eligible for planning notifications.`, result);
  }
}

function failure(
  error: string,
  result: Exclude<NotificationSubmissionResult, { queued: true }>,
): ProjectedNotificationSubmission {
  return {
    success: false,
    error,
    data: {
      queued: false,
      reason: result.reason,
      card_id: result.cardId,
      ...('status' in result ? { status: result.status } : {}),
    },
  };
}
