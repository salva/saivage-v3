import { analystIssuesSchema, type AnalystIssue, type CardStatus } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from './analyst-sanitization.js';
import { propagateChange } from '../runtime/changed-propagation.js';

export function normalizeAnalystIssues(input: unknown): AnalystIssue[] {
  const parsed = analystIssuesSchema.parse(input);
  return parsed.map((issue) => sanitizeAnalystPayload(issue, 1000) as AnalystIssue);
}

export function markGoalNeedsCorrections(projectRoot: string, store: CardStore, originGoalId: string, issues: AnalystIssue[], note?: string, notifyCard?: Parameters<typeof propagateChange>[4]): { origin_goal_id: string; status_transition: { from: CardStatus; to: CardStatus } | null } {
  const origin = store.read(originGoalId);
  if (!origin || (origin.type !== 'goal' && origin.type !== 'project')) throw new Error(`Goal '${originGoalId}' not found.`);
  const result = propagateChange(projectRoot, store, originGoalId, { kind: 'analyst_correction', issues, note: note ? sanitizeAnalystText(note, 1000) : undefined }, notifyCard);
  const ownTransition = result.flipped.find((entry) => entry.card_id === originGoalId);
  const status_transition = ownTransition ? { from: ownTransition.previous_status, to: 'changed' as const } : null;
  return { origin_goal_id: originGoalId, status_transition };
}
