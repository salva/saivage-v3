import type { CardService } from '../cards/card-service.js';
import type { CompiledRuntimeWorkflows } from '../runtime/card-process/card-process-config.js';
import type { NotificationSubmissionPort } from '../runtime/runtime-api.js';
import type { ProjectOversight } from './project-oversight.js';

export function createOversightNotificationPort(input: {
  oversight: Pick<ProjectOversight, 'assertEffectAdmission'>;
  cards: Pick<CardService, 'read'>;
  workflows: Pick<CompiledRuntimeWorkflows, 'cardTypes'>;
  submitNotification: NotificationSubmissionPort;
}): NotificationSubmissionPort {
  return async (cardId, notification, urgency, signal) => {
    if (!signal) throw new Error('Oversight notification requires the exact check cancellation signal.');
    input.oversight.assertEffectAdmission(signal);
    const card = input.cards.read(cardId);
    if (card) {
      const workflow = input.workflows.cardTypes.get(card.type);
      if (!workflow) throw new Error(`No compiled workflow for '${card.type}'.`);
      if (!workflow.planningNotificationTarget)
        return { queued: false, reason: 'planning_ineligible', cardId };
    }
    return input.submitNotification(cardId, notification, urgency, signal);
  };
}
