import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { interpolateValue } from '../../src/config/env-interpolation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function load(config: unknown, environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-key-')); roots.push(root);
  const authority = createTestConfigAuthority(root, { config, environment });
  return { authority, path: join(root, '.saivage/config/files-test.yaml') };
}
function fixture(key: string) {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  const workflow = config.card_types.goal!.workflow;
  const prompt = { reference: 'stopped-recovery', compactable: false, compaction_key: key };
  workflow.entries.STOPPED.prompt = prompt;
  const plan = workflow.nodes.plan!;
  if (plan.execution.kind !== 'agent') throw new Error('Expected agent');
  plan.execution.correction_prompt = prompt;
  plan.record_prompts = [{ record: 'brief.md', selection: 'accepted', presence: 'required', prompt: { ...prompt, reference: 'changed-record' } }];
  plan.edges.admit_review = { target: { node: 'review' }, prompt };
  workflow.nodes.review!.edges.approved = {
    target: { terminal: 'DONE', promote: 'current', export_records: ['review.md'] },
    pending_notifications: { node: 'handle-notifications', prompt },
  };
  workflow.entries.BACKLOG = { node: 'check' };
  const continuing = { target: { node: 'plan' }, prompt };
  const terminal = {
    target: { terminal: 'DONE' as const, promote: 'current' as const, export_records: [] },
    pending_notifications: { node: 'handle-notifications', prompt },
  };
  workflow.nodes.check = {
    execution: { kind: 'action', action: 'shell.run', contract_version: 1, config: { script: 'true' }, inputs: { args: { literal: [] } } },
    records: {},
    edges: {
      passed: { cases: [{ id: 'zero', when: { field: 'exit_code', op: 'eq', value: 0 }, ...continuing }], otherwise: terminal },
      failed: { cases: [{ id: 'one', when: { field: 'exit_code', op: 'eq', value: 1 }, ...terminal }], otherwise: continuing },
      signalled: continuing, timed_out: continuing,
    },
  };
  return config;
}

describe('literal durable prompt keys through selected YAML', () => {
  it('selects current bundled workflows when the complete card-type map is omitted', () => {
    const { card_types: _omitted, ...config } = structuredClone(TEST_SAIVAGE_CONFIG);
    const effective = load(config).authority.loadEffective();
    expect(Object.keys(effective.config.card_types)).toEqual(Object.keys(TEST_SAIVAGE_CONFIG.card_types));
    for (const type of Object.values(effective.config.card_types)) expect(type.workflow.format_version).toBe(4);
  });
  it.each(['${POLICY_KEY}', ' prefix-${POLICY_KEY}-É ', '   '])('preserves every admitted leaf and compiled identity: %s', key => {
    const config = fixture(key);
    const missing = load(config).authority.loadEffective();
    const present = load(config, { POLICY_KEY: 'expanded-name' }).authority.loadEffective();
    expect(missing.warnings).toEqual([]);
    expect(present.warnings).toEqual([]);
    expect(missing.config.card_types.goal).toEqual(config.card_types.goal);
    expect(present.config.card_types.goal).toEqual(missing.config.card_types.goal);
    const compiled = missing.workflows.cardTypes.get('goal')!;
    expect(present.workflows.cardTypes.get('goal')).toEqual(compiled);
    const plan = compiled.states.get('node:plan')!;
    if (plan.kind !== 'node' || plan.execution.kind !== 'agent') throw new Error('Expected agent');
    expect(plan.execution.correctionPrompt.compactionKey).toBe(key);
    expect(plan.recordPrompts[0]!.prompt.compactionKey).toBe(key);
    // Inspect the compiled entry, direct route/pending route and both conditional
    // cases/defaults, not merely the decoded YAML or one representative key.
    const counts: Record<string, number> = {};
    for (const stateId of ['entry:STOPPED', 'node:plan', 'node:review', 'node:check']) {
      const declarations = [...compiled.states.get(stateId)!.on.values()]
        .map(transition => transition.semantic)
        .filter(semantic => semantic.kind !== 'notification-interrupt' && 'prompt' in semantic && semantic.prompt?.compactionKey !== undefined);
      for (const semantic of declarations) {
        if (!('prompt' in semantic)) throw new Error('Expected prompt');
        expect(semantic.prompt).toMatchObject({ compactable: false, compactionKey: key });
      }
      counts[stateId] = declarations.length;
    }
    expect(counts).toEqual({ 'entry:STOPPED': 1, 'node:plan': 1, 'node:review': 1, 'node:check': 6 });
  });

  it.each(['empty', 'compactable', 'omitted', 'static-agent', 'static-node'])( 'rejects illegal key declaration %s', kind => {
    const config = fixture(kind === 'empty' ? '' : '${POLICY_KEY}');
    const prompt = config.card_types.goal!.workflow.entries.STOPPED.prompt;
    if (kind === 'compactable') prompt.compactable = true;
    if (kind === 'omitted') Reflect.deleteProperty(prompt, 'compactable');
    if (kind === 'static-agent') Object.assign(config.agents.planner!.prompt, { compaction_key: '${POLICY_KEY}' });
    if (kind === 'static-node') {
      const execution = config.card_types.goal!.workflow.nodes.plan!.execution;
      if (execution.kind !== 'agent') throw new Error('Expected agent');
      Object.assign(execution.prompt, { compaction_key: '${POLICY_KEY}' });
    }
    expect(() => load(config).authority.loadEffective()).toThrow();
  });

  it('still expands ordinary references/provider fields and warns for ordinary missing variables', () => {
    const config = fixture('${POLICY_KEY}');
    config.providers.test!.baseUrl = '${ENDPOINT}';
    config.card_types.goal!.workflow.entries.STOPPED.prompt.reference = '${PROMPT}';
    const result = load(config, { ENDPOINT: 'https://fixture.invalid/v1', PROMPT: 'stopped-recovery' }).authority.loadEffective();
    expect(result.config.providers.test!.baseUrl).toBe('https://fixture.invalid/v1');
    expect(result.config.card_types.goal!.workflow.entries.STOPPED.prompt.reference).toBe('stopped-recovery');
    expect(() => load(config).authority.loadEffective()).toThrow();
    config.providers.test!.apiKey = '${ORDINARY_MISSING}';
    expect(load(config, { ENDPOINT: 'https://fixture.invalid/v1', PROMPT: 'stopped-recovery' }).authority.loadEffective().warnings)
      .toEqual(["Environment variable 'ORDINARY_MISSING' is not set."]);
    expect(interpolateValue({ compaction_key: '${UNSET}' }, {})).toEqual({ value: { compaction_key: '' }, warnings: ["Environment variable 'UNSET' is not set."] });
  });

  it.each([undefined, 1, 2, 3, 5])('rejects absent/unsupported workflow %s without rewriting selected YAML', version => {
    const config = fixture('literal');
    Object.assign(config.card_types.goal!.workflow, { format_version: version });
    const { authority, path } = load(config);
    const before = readFileSync(path);
    expect(() => authority.loadEffective()).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
});
