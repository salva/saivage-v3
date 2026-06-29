import type { CardRecord, RuntimeState } from '../schemas/index.js';
import { readLatestBriefRecord } from './records/card-brief.js';

const PLANNER_CONTEXT_STRING_LIMIT = 500;
const PLANNER_CONTEXT_ARRAY_LIMIT = 5;
const PLANNER_CONTEXT_OBJECT_KEY_LIMIT = 12;
const PLANNER_CONTEXT_MAX_DEPTH = 3;

export type GoalContextResumeReason =
  | 'initial'
  | 'reviewer_correction'
  | 'analyst_directive'
  | 'subtree_changed'
  | 'service_restart';

export interface RuntimeContextCardReader {
  read(cardId: string): CardRecord | null | undefined;
  listChildren(cardId: string): string[];
  blocksFor(cardId: string): string[];
}

export function truncatePlannerContextString(value: string): string {
  if (value.length <= PLANNER_CONTEXT_STRING_LIMIT) return value;
  return `${value.slice(0, PLANNER_CONTEXT_STRING_LIMIT)}…[truncated ${value.length - PLANNER_CONTEXT_STRING_LIMIT} chars]`;
}

export function summarizeForPlannerContext(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return truncatePlannerContextString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, PLANNER_CONTEXT_ARRAY_LIMIT).map((item) => summarizeForPlannerContext(item, depth + 1));
    return value.length > PLANNER_CONTEXT_ARRAY_LIMIT
      ? { items, omitted_count: value.length - PLANNER_CONTEXT_ARRAY_LIMIT }
      : items;
  }
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= PLANNER_CONTEXT_MAX_DEPTH) {
    return {
      kind: 'object_summary',
      keys: entries.slice(0, PLANNER_CONTEXT_OBJECT_KEY_LIMIT).map(([key]) => key),
      omitted_keys: Math.max(0, entries.length - PLANNER_CONTEXT_OBJECT_KEY_LIMIT),
    };
  }
  const summarized: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, PLANNER_CONTEXT_OBJECT_KEY_LIMIT)) {
    summarized[key] = summarizeForPlannerContext(item, depth + 1);
  }
  if (entries.length > PLANNER_CONTEXT_OBJECT_KEY_LIMIT) summarized.omitted_keys = entries.length - PLANNER_CONTEXT_OBJECT_KEY_LIMIT;
  return summarized;
}

export function buildGoalEvidenceContext(input: { goalId: string; cards: RuntimeContextCardReader }): string {
  const goalResult = input.cards.read(input.goalId)?.lifecycle.result;
  const reviewState = goalResult?.kind === 'reviewer_pass' ? goalResult : undefined;
  const children = input.cards
    .listChildren(input.goalId)
    .map((id) => input.cards.read(id))
    .filter((card): card is CardRecord => Boolean(card))
    .map((card) => ({
      id: card.id,
      type: card.type,
      status: card.status,
      status_text: card.status_text ? truncatePlannerContextString(card.status_text) : null,
      result_summary: summarizeForPlannerContext(card.lifecycle.result),
      error: card.lifecycle.error ? truncatePlannerContextString(card.lifecycle.error) : null,
    }));
  return JSON.stringify(
    {
      goal_id: input.goalId,
      children,
      latest_review_summary: summarizeForPlannerContext(reviewState ?? null),
    },
    null,
    2,
  );
}

export function buildGoalContextCardTree(input: { cardId: string; cards: RuntimeContextCardReader }): Array<{
  id: string;
  type: string;
  title: string;
  status: string;
  status_text: string | null;
  depends_on: string[];
  child_card_tree?: unknown[];
}> {
  return input.cards
    .listChildren(input.cardId)
    .map((id) => input.cards.read(id))
    .filter((card): card is CardRecord => Boolean(card))
    .map((card) => {
      const children = buildGoalContextCardTree({ cardId: card.id, cards: input.cards });
      return {
        id: card.id,
        type: card.type,
        title: card.title,
        status: card.status,
        status_text: card.status_text ?? null,
        depends_on: card.depends_on,
        ...(children.length > 0 ? { child_card_tree: children } : {}),
      };
    });
}

export function buildGoalContextPayload(input: {
  projectRoot: string;
  goalId: string;
  resumeReason: GoalContextResumeReason;
  cards: RuntimeContextCardReader;
  notes: Array<Record<string, unknown>>;
  activeRun: RuntimeState['active_card_run'] | null;
}): Record<string, unknown> | null {
  const goal = input.cards.read(input.goalId);
  if (!goal) return null;
  const review = goal.lifecycle.result?.kind === 'reviewer_pass' ? goal.lifecycle.result : null;
  return {
    id: goal.id,
    type: goal.type,
    parent_card_id: goal.parent,
    depth: goal.depth,
    title: goal.title,
    brief: readLatestBriefRecord(input.projectRoot, goal.id) ?? null,
    tags: goal.tags,
    priority: goal.priority,
    depends_on: goal.depends_on,
    blocks: input.cards.blocksFor(goal.id),
    status_text: goal.status_text ?? null,
    child_card_tree: buildGoalContextCardTree({ cardId: goal.id, cards: input.cards }),
    notes: input.notes,
    latest_self_report: summarizeForPlannerContext(goal.latest_self_report ?? null),
    latest_review_result: summarizeForPlannerContext(review ?? null),
    correction_attempts: input.activeRun?.correction_attempts ?? 0,
    max_review_retries: 0,
    resume_reason: input.resumeReason,
  };
}

export function buildGoalContextBlock(input: {
  goalId: string;
  resumeReason: GoalContextResumeReason;
  payload: Record<string, unknown> | null;
}): string {
  if (!input.payload)
    return `## Goal Context\n\nGoal card '${input.goalId}' not found.\nresume_reason: ${input.resumeReason}`;
  return `## Goal Context\n\n${JSON.stringify(input.payload, null, 2)}\n\nresume_reason: ${input.resumeReason}`;
}

export function buildCardContextBlock(input: { projectRoot: string; cardId: string; goalId: string; cards: RuntimeContextCardReader }): string {
  const card = input.cards.read(input.cardId);
  const goal = input.cards.read(input.goalId);
  if (!card) return `## Card Context\n\nCard '${input.cardId}' not found.`;
  const payload = {
    card: {
      id: card.id,
      type: card.type,
      title: card.title,
      brief: readLatestBriefRecord(input.projectRoot, card.id) ?? null,
      status: card.status,
      priority: card.priority,
      depends_on: card.depends_on,
      tags: card.tags,
      parent: card.parent,
      instructions_file: card.instructions_file ?? null,
    },
    goal: goal
      ? {
          id: goal.id,
          title: goal.title,
          brief: readLatestBriefRecord(input.projectRoot, goal.id) ?? null,
        }
      : null,
  };
  return `## Card Context\n\n${JSON.stringify(payload, null, 2)}`;
}
