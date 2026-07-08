import {
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  URGENCY_VALUES,
} from '../tools/tool-definition.js';

export const ANALYST_NO_MODEL_REPLY = "Analyst LLM unavailable: no model candidate is configured for role 'analyst'. Configure a provider/model for role 'analyst' in the project configuration and try again.";

export class AnalystOfflineError extends Error {
  constructor(message: string = ANALYST_NO_MODEL_REPLY) {
    super(message);
    this.name = 'AnalystOfflineError';
  }
}

export function formatVocabularySnippet(): string {
  return [
    `Card status: ${CARD_STATUS_VALUES.join(' | ')}`,
    `Card type: ${CARD_TYPE_VALUES.join(' | ')}`,
    `Urgency: ${URGENCY_VALUES.join(' | ')}`,
    `AnalystIssue severity: ${ANALYST_ISSUE_SEVERITY_VALUES.join(' | ')}`,
  ].join('. ');
}
