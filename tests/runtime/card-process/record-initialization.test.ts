import { describe, expect, it } from '@jest/globals';
import { DEFAULT_SAIVAGE_CONFIG, resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { interpolateValue } from '../../../src/config/env-interpolation.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';

const literal = '  # ${SECRET}\n{{recordContent}}\n{{include:other}}\n';
const source = () => structuredClone(DEFAULT_SAIVAGE_CONFIG);
describe('literal workflow record initializers', () => {
  it('excludes only the exact content path, preserving parsed scalar bytes and ordinary interpolation', () => {
    const config = source();
    config.card_types.project!.records['status.md']!.initialization = { content: literal, at: ['first_required_entry'] };
    config.card_types.goal!.records['status.md']!.initialization = null;
    const input = { ...config, server: { ...config.server, host: '${NAME}' } };
    const result = interpolateValue(input, { SECRET: 'must-not-replace', NAME: 'interpolated' });
    const parsed = effectiveSaivageConfigSchema.parse(result.value);
    expect(result.warnings).toEqual([]);
    expect(parsed.server.host).toBe('interpolated');
    const workflows = compileProjectWorkflows(parsed);
    const initializer = workflows.cardTypes.get('project')!.records.get('status.md')!.initialization;
    expect(initializer).toEqual({ content: literal, at: ['first_required_entry'] });
    expect(Object.isFrozen(initializer)).toBe(true);
    expect(Object.isFrozen(initializer!.at)).toBe(true);
    expect(workflows.cardTypes.get('goal')!.records.get('status.md')!.initialization).toBeNull();
    delete config.card_types.project!.records['status.md']!.initialization;
    expect(compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config)).cardTypes.get('project')!.records.get('status.md')!.initialization).toBeNull();
  });

  it('compiles both triggers only when their owning requirements exist', () => {
    const config = source();
    config.card_types.project!.records['status.md']!.initialization = { content: literal, at: ['first_required_entry', 'clean_entry'] };
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/clean requirement/);
    config.card_types.project!.workflow.nodes.plan!.records['status.md']!.mode = 'clean';
    expect(compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config)).cardTypes.get('project')!.records.get('status.md')!.initialization?.at).toEqual(['first_required_entry', 'clean_entry']);
    config.card_types.project!.records['unused.md'] = { format: 'markdown', schema: 'unused.v1', bootstrap: false, initialization: { content: 'unused', at: ['first_required_entry'] } };
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/node requirement/);
  });

  it.each([
    { content: ' \n', at: ['first_required_entry'] },
    { content: 'x', at: [] },
    { content: 'x', at: ['first_required_entry', 'first_required_entry'] },
    { content: 'x', at: ['creation'] },
    { content: 'x', at: ['clean_entry'], path: 'other' },
  ])('rejects invalid initializer %j', (initialization) => {
    const config = source();
    config.card_types.project!.records['status.md']!.initialization = initialization as never;
    expect(() => effectiveSaivageConfigSchema.parse(config)).toThrow();
  });

  it('rejects bootstrap seeds and edit-only seed-capable continue/exists nodes', () => {
    const config = source();
    config.card_types.project!.records['brief.md']!.initialization = { content: 'x', at: ['first_required_entry'] };
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/bootstrap initialization/);
    delete config.card_types.project!.records['brief.md']!.initialization;
    for (const type of Object.values(config.card_types)) for (const node of Object.values(type.workflow.nodes))
      if (node.agent === 'planner') for (const record of Object.values(node.records ?? {})) { record.mode = 'continue'; record.gate = 'exists'; }
    config.agents.planner!.tools = config.agents.planner!.tools.filter((name) => name !== 'write');
    expect(() => compileProjectWorkflows(effectiveSaivageConfigSchema.parse(config))).toThrow(/requires the write tool/);
  });

  it('ships selectable status data in every profile rather than an engine default', () => {
    for (const profile of ['classic', 'classic-typed', 'paad-typed'] as const) {
      const template = resolveSystemTemplate(profile);
      const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(template.config), { defaultPromptRoot: template.promptRoot });
      expect(workflows.cardTypes.get('project')!.records.get('status.md')!.initialization?.at).toEqual(['first_required_entry']);
      expect(workflows.cardTypes.get('project')!.bootstrapRecord.initialization).toBeNull();
    }
  });
});
