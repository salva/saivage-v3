import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SAIVAGE_CONFIG, resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { interpolateValue } from '../../../src/config/env-interpolation.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { renderCompiledPrompt } from '../../../src/utils/prompt-api.js';

const source = () => structuredClone(DEFAULT_SAIVAGE_CONFIG);
describe('selected node-entry record templates', () => {
  it('exempts only the template field from environment expansion and renders insertion bytes once', () => {
    const config = source();
    const template = '# {{cardType}} {{cardId}} {{cardTitle}} {{nodeId}} {{recordName}} ${SECRET}\n';
    config.card_types.project!.records['status.md']!.initialization = { format_version: 1, template };
    const result = interpolateValue({ ...config, server: { ...config.server, host: '${NAME}' } }, { SECRET: 'never-insert', NAME: 'interpolated' });
    const parsed = effectiveSaivageConfigSchema.parse(result.value);
    expect(result.warnings).toEqual([]);
    expect(parsed.server.host).toBe('interpolated');
    const workflows = compileProjectWorkflows(parsed);
    const initializer = workflows.cardTypes.get('project')!.records.get('status.md')!.initialization!;
    expect(Object.isFrozen(initializer)).toBe(true);
    expect(renderCompiledPrompt({ kind: 'record-initializer', cardType: 'project' }, 'status.md', initializer.compiled,
      { cardType: 'project', cardId: 'project', cardTitle: '{{recordContent}}', nodeId: 'plan', recordName: 'status.md' }))
      .toBe('# project project {{recordContent}} plan status.md ${SECRET}\n');
  });

  it('accounts direct includes in the existing artifact closure and rejects nested includes', () => {
    const root = mkdtempSync(join(tmpdir(), 'initializer-fragments-'));
    try {
      const dir = join(root, '.saivage/config/prompts/fragments/project'); mkdirSync(dir, { recursive: true });
      const path = join(dir, 'initializer.md'); writeFileSync(path, '{{cardTitle}} ${SECRET}');
      const config = source(); config.card_types.project!.records['status.md']!.initialization = { format_version: 1, template: '{{> initializer}}' };
      const paths: string[] = [];
      const compiled = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), { projectRoot: root, artifactObserver: item => paths.push(item.path) });
      expect(paths).toContain(path);
      const initialization = compiled.cardTypes.get('project')!.records.get('status.md')!.initialization!;
      expect(renderCompiledPrompt({ kind: 'record-initializer', cardType: 'project' }, 'status.md', initialization.compiled, { cardTitle: 'Title' })).toBe('Title ${SECRET}');
      writeFileSync(path, '{{> another}}');
      expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config), { projectRoot: root })).toThrow(/contains a fragment include/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['{{recordContent}}', '{{contractDescription}}', '{{provider}}', '{{cardId', '{{cardId.foo}}'])('rejects unavailable or malformed template %s', template => {
    const config = source(); config.card_types.project!.records['status.md']!.initialization = { format_version: 1, template };
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow();
  });

  it('keeps selection independent of requirements and rejects missing definitions and authority', () => {
    const config = source();
    config.card_types.project!.records['unused.md'] = { format: 'markdown', schema: 'unused.v1', bootstrap: false, initialization: { format_version: 1, template: 'unused' } };
    config.card_types.project!.workflow.nodes.plan!.initialize_records = ['unused.md'];
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/record_writes authority/);
    config.agents.planner!.record_writes.push('unused.md');
    expect(compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config)).cardTypes.get('project')!.records.get('unused.md')!.initialization).not.toBeNull();
    config.card_types.project!.workflow.nodes.plan!.initialize_records = ['missing.md'];
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/declared nonbootstrap initializer/);
  });

  it.each([{ content: 'old', at: ['first_required_entry'] }, { format_version: 1, template: ' \n' }, { format_version: 2, template: 'x' }])('rejects obsolete/invalid initializer %j', initialization => {
    const config = source(); config.card_types.project!.records['status.md']!.initialization = initialization as never;
    expect(() => effectiveSaivageConfigSchema.parse(config)).toThrow();
  });

  it('rejects bootstrap initialization and duplicate selections', () => {
    const config = source(); config.card_types.project!.records['brief.md']!.initialization = { format_version: 1, template: 'x' };
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/bootstrap initialization/);
    delete config.card_types.project!.records['brief.md']!.initialization;
    config.card_types.project!.workflow.nodes.plan!.initialize_records = ['status.md', 'status.md'];
    expect(() => effectiveSaivageConfigSchema.parse(config)).toThrow(/Duplicate initialized record/);
  });

  it.each(['classic', 'classic-typed', 'paad-typed'] as const)('ships explicit status selection in %s', profile => {
    const template = resolveSystemTemplate(profile);
    const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(template.config), { defaultPromptRoot: template.promptRoot });
    const workflow = workflows.cardTypes.get('project')!;
    const plan = workflow.states.get('node:plan')!;
    expect(plan.kind === 'node' && plan.initializeRecords.map(record => record.name)).toContain('status.md');
    expect(workflow.bootstrapRecord.initialization).toBeNull();
  });
});
