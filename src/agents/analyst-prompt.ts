import {
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  URGENCY_VALUES,
} from '../tools/tool-definition.js';
import type { CardTypeName } from '../schemas/index.js';

export function formatVocabularySnippet(cardTypeVocabulary: readonly CardTypeName[]): string {
  return [
    `Card status: ${CARD_STATUS_VALUES.join(' | ')}`,
    'Reopenable card status: blocked | done | failed. Reopen target status: changed',
    `Card type: ${cardTypeVocabulary.join(' | ')}`,
    `Urgency: ${URGENCY_VALUES.join(' | ')}`,
    `AnalystIssue severity: ${ANALYST_ISSUE_SEVERITY_VALUES.join(' | ')}`,
  ].join('. ');
}
