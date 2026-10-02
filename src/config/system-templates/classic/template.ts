import { fileURLToPath } from 'node:url';
import type { CardTypeName, CardTypesSource } from '../../../schemas/index.js';
import { createClassicConfig } from '../classic-shared.js';
const prompt = (reference: string) => ({ reference, compactable: true });

const allNonRootTypes = [
  'goal',
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
] as const;

function planningCardType(): CardTypesSource[CardTypeName] {
  return {
    permitted_child_types: [...allNonRootTypes],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      notification_recipient: 'planner',
      entries: {
        BACKLOG: { node: 'plan' },
        CHANGED: { node: 'plan' },
        BLOCKED: { node: 'plan' },
        STOPPED: { node: 'recover', prompt: prompt('stopped-recovery') },
      },
      nodes: {
        plan: {
          agent: 'planner',
          prompt: prompt('plan'),
          correction_prompt: prompt('correct-plan-result'),
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            complete_direct: {
              target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] },
            },
            admit_review: { target: { node: 'review' }, prompt: prompt('plan-to-review') },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] },
            },
          },
        },
        review: {
          agent: 'reviewer',
          prompt: prompt('review'),
          correction_prompt: prompt('correct-review-result'),
          records: { 'review.md': { mode: 'clean', gate: 'updated' } },
          descendant_context: { records: ['status.md'], require_unchanged_until_accept: true },
          edges: {
            approved: {
              target: { terminal: 'DONE', promote: 'current', export_records: ['review.md'] },
              pending_notifications: {
                node: 'handle-notifications',
                prompt: prompt('review-to-notifications'),
              },
            },
            revision_required: { target: { node: 'plan' }, prompt: prompt('review-to-plan') },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['review.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['review.md'] },
            },
          },
        },
        recover: {
          agent: 'planner',
          prompt: prompt('recover'),
          correction_prompt: prompt('correct-plan-result'),
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            complete_direct: {
              target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] },
            },
            admit_review: { target: { node: 'review' }, prompt: prompt('plan-to-review') },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] },
            },
          },
        },
        'handle-notifications': {
          agent: 'planner',
          prompt: prompt('handle-notifications'),
          correction_prompt: prompt('correct-plan-result'),
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            admit_review: { target: { node: 'review' }, prompt: prompt('plan-to-review') },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] },
            },
          },
        },
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
      notification_recipient: 'executor',
      entries: {
        BACKLOG: { node: 'execute' },
        CHANGED: { node: 'execute' },
        BLOCKED: { node: 'execute' },
        STOPPED: { node: 'execute', prompt: prompt('stopped-recovery') },
      },
      nodes: {
        execute: {
          agent: 'executor',
          prompt: prompt('execute'),
          correction_prompt: prompt('correct-execution-result'),
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            done: {
              target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] },
            },
            blocked: {
              target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
            },
            failed: {
              target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] },
            },
          },
        },
      },
    },
  };
}

const cardTypes: CardTypesSource = {
  project: planningCardType(),
  goal: planningCardType(),
  architecture: executionCardType(),
  code: executionCardType(),
  test: executionCardType(),
  doc: executionCardType(),
  data: executionCardType(),
  research: executionCardType(),
  ops: executionCardType(),
};

const config = createClassicConfig(cardTypes);

export const CLASSIC_TEMPLATE = Object.freeze({
  name: 'classic',
  config,
  promptRoot: fileURLToPath(new URL('./prompts/', import.meta.url)),
});
