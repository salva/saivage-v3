import type { CardTypeSetDefinition } from '../../../src/config/card-type-sets/registry.js';
import type { CardTypesSource } from '../../../src/schemas/saivage-config.js';

const cardTypes: CardTypesSource = Object.freeze({
  project: {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
    },
    workflow: {
      entries: {
        BACKLOG: { node: 'execute' },
        CHANGED: { node: 'execute' },
        BLOCKED: { node: 'execute' },
        STOPPED: { node: 'execute', prompt: 'stopped-recovery' },
      },
      nodes: {
        execute: {
          agent: 'executor',
          prompt: 'execute',
          correction_prompt: 'correct-execution-result',
          records: { 'status.md': { mode: 'continue', gate: 'updated' } },
          edges: {
            done: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } },
            blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } },
            failed: { target: { terminal: 'FAILED', promote: 'current', export_records: ['status.md'] } },
          },
        },
      },
    },
  },
});

export const MINIMAL_CARD_TYPE_SET: CardTypeSetDefinition = Object.freeze({
  name: 'minimal',
  cardTypes,
});
