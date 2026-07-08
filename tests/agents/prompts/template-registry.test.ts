import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createPromptTemplateRegistry,
  PromptTemplateRenderError,
  type AgentRoleKey,
  type PromptTemplateVariables,
} from '../../../src/utils/prompt-api.js';
import { activePromptPairs, type PromptCardTypeKey } from '../../../src/schemas/index.js';

const activePairs = activePromptPairs;

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

function templateFor(cardType: PromptCardTypeKey, role: AgentRoleKey): string {
  switch (role) {
    case 'planner':
      return `${cardType} planner {{cardId}} {{cardTitle}} {{cardBrief}} {{contractDescription}} {{toolList}}`;
    case 'executor':
      return `${cardType} executor {{cardId}} {{cardTitle}} {{cardBrief}} {{contractDescription}} {{toolList}} {{cardType}}`;
    case 'reviewer':
      return `${cardType} reviewer {{cardId}} {{cardTitle}} {{cardBrief}} {{assessmentId}} {{contractDescription}} {{toolList}}`;
    case 'analyst':
      return 'analyst {{toolList}} {{vocabularySnippet}} {{projectContext}}';
  }
}

function writePrompt(root: string, cardType: PromptCardTypeKey, role: AgentRoleKey, template: string): void {
  const path = join(root, cardType, `${role}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, template);
}

function withDefaults(mutator?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-prompts-'));
  for (const [cardType, role] of activePairs) writePrompt(root, cardType, role, templateFor(cardType, role));
  mutator?.(root);
  return root;
}

describe('PromptTemplateRegistry', () => {
  it('loads and renders source-tree defaults for all active pairs', () => {
    const registry = createPromptTemplateRegistry({ defaultRoot: 'src/prompts' });
    for (const [cardType, role] of activePairs) {
      const rendered = registry.render(cardType, role, variables(role, { cardType }));
      expect(rendered).toContain('Saivage');
      expect(rendered).not.toContain('{{');
      expect(rendered).not.toContain('}}');
    }
    expect(activePairs).toContainEqual(['analyst', 'analyst']);
  });

  it('keeps project prompt defaults project-specific', () => {
    const projectPlanner = readFileSync('src/prompts/project/planner.md', 'utf8');
    const projectReviewer = readFileSync('src/prompts/project/reviewer.md', 'utf8');
    const goalPlanner = readFileSync('src/prompts/goal/planner.md', 'utf8');
    const goalReviewer = readFileSync('src/prompts/goal/reviewer.md', 'utf8');

    expect(projectPlanner).toContain('canonical project card');
    expect(projectPlanner).toContain('top-level project card');
    expect(projectPlanner).not.toContain('Planner for goal card');
    expect(projectPlanner).not.toContain('one goal subtree');
    expect(projectReviewer).toContain('completed project/root tree');
    expect(projectReviewer).not.toContain("goal's acceptance criteria");
    expect(projectPlanner).not.toBe(goalPlanner);
    expect(projectReviewer).not.toBe(goalReviewer);
  });

  it('uses file-level overlay replacements and falls back when overlay files are missing', () => {
    const defaultRoot = withDefaults();
    const overrideRoot = mkdtempSync(join(tmpdir(), 'saivage-prompt-overrides-'));
    try {
      writePrompt(overrideRoot, 'goal', 'planner', 'override {{cardId}}');
      const registry = createPromptTemplateRegistry({ defaultRoot, overrideRoot });
      expect(registry.render('goal', 'planner', variables('planner'))).toBe('override card-1');
      expect(registry.render('project', 'planner', variables('planner'))).toContain('project planner card-1');
    } finally {
      rmSync(defaultRoot, { recursive: true, force: true });
      rmSync(overrideRoot, { recursive: true, force: true });
    }
  });

  it('fails construction when an active effective template is missing', () => {
    const defaultRoot = withDefaults((root) => rmSync(join(root, 'analyst', 'analyst.md')));
    try {
      expect(() => createPromptTemplateRegistry({ defaultRoot })).toThrow(/analyst\/analyst/);
    } finally {
      rmSync(defaultRoot, { recursive: true, force: true });
    }
  });

  it('validates unknown and cross-role placeholders during construction', () => {
    const badPlanner = withDefaults((root) => writePrompt(root, 'goal', 'planner', 'bad {{projectContext}}'));
    const badExecutor = withDefaults((root) => writePrompt(root, 'code', 'executor', 'bad {{assessmentId}}'));
    try {
      expect(() => createPromptTemplateRegistry({ defaultRoot: badPlanner })).toThrow(PromptTemplateRenderError);
      expect(() => createPromptTemplateRegistry({ defaultRoot: badExecutor })).toThrow(PromptTemplateRenderError);
    } finally {
      rmSync(badPlanner, { recursive: true, force: true });
      rmSync(badExecutor, { recursive: true, force: true });
    }
  });

  it('rejects the removed executor guidance placeholder as unknown', () => {
    const removedGuidancePlaceholder = `${'cardType'}Guidance`;
    const defaultRoot = withDefaults((root) => writePrompt(root, 'code', 'executor', `bad {{${removedGuidancePlaceholder}}}`));
    try {
      expect(() => createPromptTemplateRegistry({ defaultRoot })).toThrow(PromptTemplateRenderError);
      expect(() => createPromptTemplateRegistry({ defaultRoot })).toThrow(removedGuidancePlaceholder);
    } finally {
      rmSync(defaultRoot, { recursive: true, force: true });
    }
  });

  it('does not re-tokenize inserted variable values and rejects missing variables', () => {
    const defaultRoot = withDefaults((root) => writePrompt(root, 'goal', 'planner', 'brief: {{cardBrief}}'));
    try {
      const registry = createPromptTemplateRegistry({ defaultRoot });
      expect(registry.render('goal', 'planner', variables('planner', { cardBrief: 'literal {{unknownKey}} and }}' }))).toBe('brief: literal {{unknownKey}} and }}');
      expect(() => registry.render('goal', 'planner', { cardId: 'card-1' })).toThrow(PromptTemplateRenderError);
    } finally {
      rmSync(defaultRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed placeholders during construction', () => {
    const cases: Array<[string, string]> = [
      ['{{cardId}', 'unclosed placeholder'],
      ['{{outer {{inner}}', 'nested placeholder open before close'],
      ['{{card-id}}', 'invalid placeholder identifier'],
      ['{{1card}}', 'invalid placeholder identifier'],
      ['use }} for objects', "stray '}}'"],
    ];

    for (const [template, reason] of cases) {
      const defaultRoot = withDefaults((root) => writePrompt(root, 'goal', 'planner', template));
      try {
        expect(() => createPromptTemplateRegistry({ defaultRoot })).toThrow(PromptTemplateRenderError);
        expect(() => createPromptTemplateRegistry({ defaultRoot })).toThrow(reason);
      } finally {
        rmSync(defaultRoot, { recursive: true, force: true });
      }
    }
  });
});
