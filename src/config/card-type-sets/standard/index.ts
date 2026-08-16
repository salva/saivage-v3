import type { CardTypeName, CardTypesSource } from '../../../schemas/index.js';
import type { CardTypeSetDefinition } from '../registry.js';

const allNonRootTypes = ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function planningCardType(): CardTypesSource[CardTypeName] {
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'plan' }, CHANGED: { node: 'plan' }, BLOCKED: { node: 'plan' }, STOPPED: { node: 'recover', prompt: 'stopped-recovery' } },
      nodes: {
        plan: { agent: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
        review: { agent: 'reviewer', prompt: 'review', correction_prompt: 'correct-review-result', records: { 'review.md': { mode: 'clean', gate: 'updated' } }, descendant_context: { records: ['status.md'], require_unchanged_until_accept: true }, edges: {
          approved: { target: { terminal: 'DONE', promote: 'current', export_records: ['review.md'] } },
          revision_required: { target: { node: 'plan' }, prompt: 'review-to-plan' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['review.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['review.md'] } },
        } },
        recover: { agent: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
          complete_direct: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
          failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
        } },
      },
    },
  };
}

function executionCardType(): CardTypesSource[CardTypeName] {
  return {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: 'stopped-recovery' } },
      nodes: { execute: { agent: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: {
        done: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
        blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
        failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
      } } },
    },
  };
}

const cardTypes: CardTypesSource = deepFreeze({
  project: planningCardType(), goal: planningCardType(), architecture: executionCardType(), code: executionCardType(), test: executionCardType(), doc: executionCardType(), data: executionCardType(), research: executionCardType(), ops: executionCardType(),
});

export const STANDARD_CARD_TYPE_SET: CardTypeSetDefinition = Object.freeze({
  name: 'standard',
  cardTypes,
});
