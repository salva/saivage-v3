import { describe, expect, it } from '@jest/globals';

import {
  createPromptTemplateRegistry,
  executorTypeGuidance,
  PromptTemplateRenderError,
  type AgentRoleKey,
  type PromptTemplateVariables,
} from '../../../src/utils/prompt-api.js';

const projectRoot = process.cwd();
const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'] as const satisfies readonly AgentRoleKey[];

function variables(role: AgentRoleKey, overrides: PromptTemplateVariables = {}): PromptTemplateVariables {
  const common = {
    cardId: 'card-1',
    cardTitle: 'Implement a feature',
    cardBrief: 'Brief text',
    contractDescription: 'Contract text',
    toolList: '- read: Read files',
    skills: '',
    ...overrides,
  };
  switch (role) {
    case 'planner':
      return { ...common, goalDepth: '1', maxDepth: '3' };
    case 'executor':
      return { ...common, cardType: 'code', cardTypeGuidance: executorTypeGuidance('code') };
    case 'reviewer':
      return { ...common, assessmentId: 'assessment-1' };
    case 'analyst':
      return {
        toolList: '- get_status: Get status',
        vocabularySnippet: 'Card status: done | blocked',
        projectContext: '{"projectRoot":"/work"}',
        skills: '',
        ...overrides,
      };
  }
}

function create(overrides: Partial<Record<AgentRoleKey, string>> = {}) {
  return createPromptTemplateRegistry({ projectRoot, promptsConfig: overrides });
}

describe('PromptTemplateRegistry', () => {
  it('loads and renders shipped defaults for all four roles', () => {
    const registry = create();
    for (const role of roleKeys) {
      const rendered = registry.render(role, variables(role));
      expect(rendered).toContain('Saivage');
      expect(rendered).not.toContain('{{');
      expect(rendered).not.toContain('}}');
    }
  });

  it('uses per-role string overrides instead of defaults', () => {
    const registry = create({ planner: 'custom {{cardId}} {{skills}}' });
    expect(registry.render('planner', variables('planner'))).toBe('custom card-1 ');
  });

  it('validates unknown and cross-role placeholders during construction', () => {
    expect(() => create({ planner: 'bad {{contratcDescription}}' })).toThrow(PromptTemplateRenderError);
    expect(() => create({ planner: 'bad {{projectContext}}' })).toThrow(PromptTemplateRenderError);
  });

  it('does not re-tokenize inserted variable values', () => {
    const registry = create({ planner: 'brief: {{cardBrief}}' });
    const rendered = registry.render('planner', variables('planner', {
      cardBrief: 'literal {{unknownKey}} and {{card-id}} and }}',
    }));
    expect(rendered).toBe('brief: literal {{unknownKey}} and {{card-id}} and }}');
  });

  it('renders empty string variables and rejects missing variables', () => {
    const registry = create({ planner: 'before{{skills}}after {{cardId}}' });
    expect(registry.render('planner', variables('planner'))).toBe('beforeafter card-1');
    expect(() => registry.render('planner', { cardId: 'card-1' })).toThrow(PromptTemplateRenderError);
  });

  it('allows templates with no placeholders to render verbatim', () => {
    const registry = create({ reviewer: 'static reviewer prompt' });
    expect(registry.render('reviewer', variables('reviewer'))).toBe('static reviewer prompt');
  });

  it('fails construction when a default role is missing', () => {
    expect(() =>
      createPromptTemplateRegistry({
        projectRoot,
        defaultTemplatesForTest: {
          planner: 'p',
          executor: 'e',
          reviewer: 'r',
        },
      }),
    ).toThrow(/analyst/);
  });

  it('allows skills as an empty placeholder for all roles', () => {
    for (const role of roleKeys) {
      const registry = create({ [role]: 'before{{skills}}after' });
      expect(registry.render(role, variables(role))).toBe('beforeafter');
    }
  });

  it('rejects malformed placeholders during construction', () => {
    const cases: Array<[string, string]> = [
      ['{{cardId}', 'unclosed placeholder'],
      ['You are the planner for {{cardId', 'unclosed placeholder'],
      ['{{outer {{inner}}', 'nested placeholder open before close'],
      ['{{card-id}}', 'invalid placeholder identifier'],
      ['{{ card.id }}', 'invalid placeholder identifier'],
      ['{{card id}}', 'invalid placeholder identifier'],
      ['{{1card}}', 'invalid placeholder identifier'],
      ['{{}}', 'invalid placeholder identifier'],
      ['{{ }}', 'invalid placeholder identifier'],
      ['use }} for objects', "stray '}}'"],
      ['{{cardId }} text }}', "stray '}}'"],
    ];

    for (const [template, reason] of cases) {
      expect(() => create({ planner: template })).toThrow(PromptTemplateRenderError);
      expect(() => create({ planner: template })).toThrow(reason);
    }
  });

  it('rejects malformed and unknown-placeholder overrides for each role', () => {
    for (const role of roleKeys) {
      expect(() => create({ [role]: '{{bad-key}}' })).toThrow(PromptTemplateRenderError);
      expect(() => create({ [role]: '{{unknownPlaceholder}}' })).toThrow(PromptTemplateRenderError);
    }
  });
});
