import { resolveSystemTemplate, type SystemTemplateDefinition } from '../../../src/config/system-templates/registry.js';
import type { CardTypesSource, SaivageConfigSource } from '../../../src/schemas/saivage-config.js';

function minimalCardTypes(nodeAgent: 'executor' | 'specialist', prompt: string): CardTypesSource {
  return {
    project: {
      permitted_child_types: [],
      records: {
        'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
        'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      },
      workflow: {
        notification_recipient: nodeAgent,
        entries: {
          BACKLOG: { node: 'execute' },
          CHANGED: { node: 'execute' },
          BLOCKED: { node: 'execute' },
          STOPPED: { node: 'execute', prompt: 'stopped-recovery' },
        },
        nodes: {
          execute: {
            agent: nodeAgent,
            prompt,
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
  };
}

function templateGlobals(): Omit<SaivageConfigSource, 'card_types'> {
  const { card_types: _cardTypes, ...globals } = structuredClone(resolveSystemTemplate('classic').config);
  return globals;
}

export function minimalSystemTemplate(promptRoot: string): SystemTemplateDefinition {
  return { name: 'minimal', config: { ...templateGlobals(), card_types: minimalCardTypes('executor', 'execute') }, promptRoot };
}

export function secondSystemTemplate(promptRoot: string): SystemTemplateDefinition {
  const config = { ...templateGlobals(), card_types: minimalCardTypes('specialist', 'second-execute') };
  config.agents = { ...config.agents, specialist: { ...structuredClone(config.agents.executor!), prompt: 'specialist' } };
  return { name: 'second', config, promptRoot };
}
