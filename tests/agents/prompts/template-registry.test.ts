import { describe, expect, it } from '@jest/globals';

import {
  createPromptTemplateRegistry,
  PromptTemplateRenderError,
  type AgentRoleKey,
  type PromptDefaultBundle,
  type PromptTemplateVariables,
} from '../../../src/utils/prompt-api.js';

const roleKeys = ['planner', 'executor', 'reviewer', 'analyst'] as const satisfies readonly AgentRoleKey[];

const defaultBundle: PromptDefaultBundle = {
  planner: 'planner {{cardId}} {{cardTitle}} {{cardBrief}} {{contractDescription}} {{toolList}}',
  executor: 'executor {{cardId}} {{cardTitle}} {{cardBrief}} {{contractDescription}} {{toolList}} {{cardType}} {{cardTypeGuidance}}',
  reviewer: 'reviewer {{cardId}} {{cardTitle}} {{cardBrief}} {{assessmentId}} {{contractDescription}} {{toolList}}',
  analyst: 'analyst {{toolList}} {{vocabularySnippet}} {{projectContext}}',
  cardTypeGuidance: {
    code: 'code guidance for {{cardType}}',
    default: 'default guidance for {{cardType}}',
  },
};

function variables(role: AgentRoleKey, overrides: PromptTemplateVariables = {}): PromptTemplateVariables {
  const common = {
    cardId: 'card-1',
    cardTitle: 'Implement a feature',
    cardBrief: 'Brief text',
    contractDescription: 'Contract text',
    toolList: '- read: Read files',
    ...overrides,
  };
  switch (role) {
    case 'planner':
      return common;
    case 'executor':
      return { ...common, cardType: overrides.cardType ?? 'code' };
    case 'reviewer':
      return { ...common, assessmentId: 'assessment-1' };
    case 'analyst':
      return {
        toolList: '- get_status: Get status',
        vocabularySnippet: 'Card status: done | blocked',
        projectContext: '{"projectRoot":"/work"}',
        ...overrides,
      };
  }
}

function create(overrides: Partial<Record<AgentRoleKey, string>> = {}) {
  return createPromptTemplateRegistry({ promptsConfig: overrides });
}

function createWithBundle(bundle: Partial<PromptDefaultBundle>) {
  return createPromptTemplateRegistry({ defaultBundleForTest: bundle as PromptDefaultBundle });
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
    const registry = create({ planner: 'custom {{cardId}}' });
    expect(registry.render('planner', variables('planner'))).toBe('custom card-1');
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
    const registry = create({ planner: 'before{{cardBrief}}after {{cardId}}' });
    expect(registry.render('planner', variables('planner', { cardBrief: '' }))).toBe('beforeafter card-1');
    expect(() => registry.render('planner', { cardId: 'card-1' })).toThrow(PromptTemplateRenderError);
  });

  it('allows templates with no placeholders to render verbatim', () => {
    const registry = create({ reviewer: 'static reviewer prompt' });
    expect(registry.render('reviewer', variables('reviewer'))).toBe('static reviewer prompt');
  });

  it('fails construction when a default role is missing', () => {
    expect(() =>
      createPromptTemplateRegistry({
        defaultBundleForTest: {
          planner: 'p',
          executor: 'e',
          reviewer: 'r',
          cardTypeGuidance: { default: 'default {{cardType}}' },
        } as PromptDefaultBundle,
      }),
    ).toThrow(/analyst/);
  });

  it('rejects removed dead placeholders for every role that used to accept them', () => {
    for (const role of roleKeys) {
      expect(() => create({ [role]: `before{{${'skills'}}}after` })).toThrow(PromptTemplateRenderError);
    }
    expect(() => create({ planner: `{{${'goal' + 'Depth'}}}` })).toThrow(PromptTemplateRenderError);
    expect(() => create({ planner: `{{${'max' + 'Depth'}}}` })).toThrow(PromptTemplateRenderError);
  });

  it('derives executor card-type guidance from the default bundle without mutating caller variables', () => {
    const registry = createPromptTemplateRegistry({ defaultBundleForTest: defaultBundle });
    const knownVariables = variables('executor', { cardType: 'code' });
    expect(registry.render('executor', knownVariables)).toContain('code guidance for code');
    expect(knownVariables).not.toHaveProperty('cardTypeGuidance');

    expect(registry.render('executor', variables('executor', { cardType: 'custom' }))).toContain('default guidance for custom');
    expect(registry.render('executor', variables('executor', { cardType: '' }))).not.toContain('guidance for');
  });

  it('does not require or inject card-type guidance when the executor template omits the placeholder', () => {
    const registry = createPromptTemplateRegistry({
      defaultBundleForTest: {
        ...defaultBundle,
        executor: 'executor {{cardId}} {{cardTitle}}',
      },
    });

    expect(registry.render('executor', { cardId: 'card-1', cardTitle: 'No guidance' })).toBe('executor card-1 No guidance');
  });

  it('renders card-type guidance when the executor template includes the placeholder', () => {
    const registry = createPromptTemplateRegistry({
      defaultBundleForTest: {
        ...defaultBundle,
        executor: 'executor {{cardTypeGuidance}}',
      },
    });

    expect(registry.render('executor', { cardType: 'code' })).toBe('executor code guidance for code');
    expect(registry.render('executor', { cardType: 'custom' })).toBe('executor default guidance for custom');
  });

  it('validates card-type guidance bundle shape during construction', () => {
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: undefined as never })).toThrow(/cardTypeGuidance/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: [] as never })).toThrow(/cardTypeGuidance/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { code: 'code' } as never })).toThrow(/default/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: '' } })).toThrow(/default/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: 7 as never } })).toThrow(/default/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: 'ok', code: '' } })).toThrow(/code/);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: 'ok', code: 7 as never } })).toThrow(/code/);
  });

  it('validates card-type guidance placeholders during construction', () => {
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: '{{cardTitle}}' } })).toThrow(PromptTemplateRenderError);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: '{{unknown}}' } })).toThrow(PromptTemplateRenderError);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: '{{cardType}' } })).toThrow(PromptTemplateRenderError);
    expect(() => createWithBundle({ ...defaultBundle, cardTypeGuidance: { default: '{{card-type}}' } })).toThrow(PromptTemplateRenderError);
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
