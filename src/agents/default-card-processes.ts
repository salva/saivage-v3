import type { CardProcessesSource } from './config-schema.js';

export const DEFAULT_CARD_PROCESSES = {
  planning: {
    entries: {
      BACKLOG: { node: 'plan' },
      CHANGED: { node: 'plan' },
      BLOCKED: { node: 'plan' },
      STOPPED: { node: 'recover', prompt: 'stopped-recovery' },
    },
    nodes: {
      plan: {
        role: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: [{ name: 'status.md', updated: true }],
        edges: {
          complete_direct: { target: { terminal: 'DONE' } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED' } },
          failed: { target: { terminal: 'FAILED' } },
        },
      },
      review: {
        role: 'reviewer', prompt: 'review', correction_prompt: 'correct-review-result', records: [{ name: 'review.md', updated: true }],
        edges: {
          approved: { target: { terminal: 'DONE' } },
          revision_required: { target: { node: 'plan' }, prompt: 'review-to-plan' },
          blocked: { target: { terminal: 'BLOCKED' } },
          failed: { target: { terminal: 'FAILED' } },
        },
      },
      recover: {
        role: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: [{ name: 'status.md', updated: true }],
        edges: {
          complete_direct: { target: { terminal: 'DONE' } },
          admit_review: { target: { node: 'review' }, prompt: 'plan-to-review' },
          blocked: { target: { terminal: 'BLOCKED' } },
          failed: { target: { terminal: 'FAILED' } },
        },
      },
    },
  },
  terminal: {
    entries: {
      BACKLOG: { node: 'execute' },
      CHANGED: { node: 'execute' },
      BLOCKED: { node: 'execute' },
      STOPPED: { node: 'execute', prompt: 'stopped-recovery' },
    },
    nodes: {
      execute: {
        role: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }],
        edges: {
          done: { target: { terminal: 'DONE' } },
          blocked: { target: { terminal: 'BLOCKED' } },
          failed: { target: { terminal: 'FAILED' } },
        },
      },
    },
  },
} as const satisfies CardProcessesSource;
