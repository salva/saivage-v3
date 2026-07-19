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
import { DEFAULT_CARD_PROCESSES } from '../../../src/agents/default-card-processes.js';
import { cardProcessesSchema } from '../../../src/agents/config-schema.js';
import { compileCardProcesses, describeNodeResultContract } from '../../../src/runtime/card-process/card-process-config.js';

const activePairs = activePromptPairs;

function variables(role: AgentRoleKey, overrides: PromptTemplateVariables = {}): PromptTemplateVariables {
  const common = {
    cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
      return common;
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
      return `${cardType} reviewer {{cardId}} {{cardTitle}} {{cardBrief}} {{contractDescription}} {{toolList}}`;
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
      expect(registry.render('goal', 'planner', variables('planner'))).toBe('override card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(registry.render('project', 'planner', variables('planner'))).toContain('project planner card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
      expect(() => registry.render('goal', 'planner', { cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow(PromptTemplateRenderError);
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

  it('validates and renders all eleven bundled process-role templates with generated contract authority', () => {
    const registry = createPromptTemplateRegistry({ defaultRoot: 'src/prompts' });
    const sentinel = 'SENTINEL CONTRACT: outcome is alpha-route | beta-route; summary is required.';
    const processPairs = activePairs.filter((pair) => pair[1] !== 'analyst');
    expect(processPairs).toHaveLength(11);
    for (const [cardType, role] of processPairs) {
      const rendered = registry.validateProcessNode(cardType, role, variables(role, { cardType, contractDescription: sentinel }));
      expect(rendered.split(sentinel)).toHaveLength(2);
      expect(rendered).toContain('sole authority');
      expect(rendered).not.toMatch(/emit_result[^\n]*\bstatus\b/i);
      expect(rendered).not.toMatch(/terminal statuses?/i);
      expect(rendered).not.toMatch(/report[^\n]*\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b/i);
    }
  });

  it('rejects zero/two contract placeholders and each finite obsolete directive with exact effective identity and path', () => {
    const badTemplates = [
      'planner without contract',
      '{{contractDescription}} and {{contractDescription}}',
      '{{contractDescription}}\nUse emit_result with status done, blocked, or failed.',
      '{{contractDescription}}\nUse only terminal statuses done, rework, blocked, or failed.',
      '{{contractDescription}}\nReport honestly with done, blocked, or failed.',
    ];
    for (const bad of badTemplates) {
      const defaultRoot = withDefaults((root) => writePrompt(root, 'goal', 'planner', bad));
      try {
        const registry = createPromptTemplateRegistry({ defaultRoot });
        expect(() => registry.validateProcessNode('goal', 'planner', variables('planner'))).toThrow(/goal\/planner/);
        expect(() => registry.validateProcessNode('goal', 'planner', variables('planner'))).toThrow(new RegExp(defaultRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } finally {
        rmSync(defaultRoot, { recursive: true, force: true });
      }
    }
  });

  it('accepts a corrected override and falls back to the bundled current template after override removal', () => {
    const overrideRoot = mkdtempSync(join(tmpdir(), 'saivage-role-cutover-'));
    try {
      writePrompt(overrideRoot, 'goal', 'planner', 'Current override {{contractDescription}} {{cardId}}');
      const overridden = createPromptTemplateRegistry({ defaultRoot: 'src/prompts', overrideRoot });
      expect(overridden.validateProcessNode('goal', 'planner', variables('planner'))).toContain('Current override Contract text');
      rmSync(join(overrideRoot, 'goal', 'planner.md'));
      const bundled = createPromptTemplateRegistry({ defaultRoot: 'src/prompts', overrideRoot });
      expect(bundled.validateProcessNode('goal', 'planner', variables('planner'))).toContain('sole authority');
    } finally {
      rmSync(overrideRoot, { recursive: true, force: true });
    }
  });

  it('renders distinct planner/reviewer contracts and two sequential executor-node contracts without base topology claims', () => {
    const processSource = cardProcessesSchema.parse(structuredClone(DEFAULT_CARD_PROCESSES));
    processSource.terminal.nodes = {
      implement: {
        role: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: [],
        edges: {
          implementation_ready: { target: { node: 'verify' }, prompt: 'execute' },
          blocked: { target: { terminal: 'BLOCKED' } }, failed: { target: { terminal: 'FAILED' } },
        },
      },
      verify: {
        role: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: [],
        edges: {
          verified: { target: { terminal: 'DONE' } },
          blocked: { target: { terminal: 'BLOCKED' } }, failed: { target: { terminal: 'FAILED' } },
        },
      },
    };
    for (const port of ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const) processSource.terminal.entries[port].node = 'implement';
    const compiled = compileCardProcesses(processSource);
    const registry = createPromptTemplateRegistry({ defaultRoot: 'src/prompts' });
    const planner = describeNodeResultContract(compiled.planning, 'node:plan');
    const reviewer = describeNodeResultContract(compiled.planning, 'node:review');
    expect(registry.validateProcessNode('goal', 'planner', variables('planner', { contractDescription: planner }))).toContain('complete_direct | admit_review | blocked | failed');
    expect(registry.validateProcessNode('goal', 'reviewer', variables('reviewer', { contractDescription: reviewer }))).toContain('approved | revision_required | blocked | failed');
    for (const cardType of ['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const) {
      const implementContract = describeNodeResultContract(compiled.terminal, 'node:implement');
      const verifyContract = describeNodeResultContract(compiled.terminal, 'node:verify');
      const implement = registry.validateProcessNode(cardType, 'executor', variables('executor', { cardType, contractDescription: implementContract }));
      const verify = registry.validateProcessNode(cardType, 'executor', variables('executor', { cardType, contractDescription: verifyContract }));
      for (const rendered of [implement, verify]) {
        expect(rendered).toContain('current configured executor node step');
        expect(rendered).not.toContain('Execute the card once for the current activation');
        expect(rendered).not.toMatch(/only executor step|completes? the card/i);
      }
      expect(implement).toContain('implementation_ready | blocked | failed');
      expect(implement).not.toContain('verified | blocked | failed');
      expect(verify).toContain('verified | blocked | failed');
      expect(verify).not.toContain('implementation_ready | blocked | failed');
    }
  });

  it('keeps the finite bundled source inventory free of old result directives and the executor one-pass sentence', () => {
    for (const [cardType, role] of activePairs.filter(([, role]) => role !== 'analyst')) {
      const source = readFileSync(join('src/prompts', cardType, `${role}.md`), 'utf8');
      expect(source).not.toMatch(/emit_result[^\n]*\bstatus\b/i);
      expect(source).not.toMatch(/terminal statuses?[^\n]*(?:done|rework|blocked|failed)/i);
      expect(source).not.toMatch(/report[^\n]*\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b/i);
      if (role === 'executor') expect(source).not.toContain('Execute the card once for the current activation');
    }
  });
});
