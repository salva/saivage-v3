import { describe, expect, it } from '@jest/globals';
import { SYSTEM_TEMPLATES } from '../../../src/config/system-templates/registry.js';
import { agentCapabilitiesSchema, effectiveSaivageConfigSchema, parseRecordName } from '../../../src/schemas/index.js';
import { agentCanWriteRecord, compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { resolveRuntimeTool, toolCapabilityResources } from '../../../src/tools/tool-api.js';
import { templateConfig } from '../../helpers/system-template-config.js';

const classic = () => effectiveSaivageConfigSchema.parse(templateConfig(
  SYSTEM_TEMPLATES.find(({ name }) => name === 'classic')!,
));

describe('compiled direct-object capabilities', () => {
  it.each(SYSTEM_TEMPLATES.map((template) => [template.name, template] as const))(
    '%s selects ordered tools and separates self status from child assignments', (_name, template) => {
      const config = effectiveSaivageConfigSchema.parse(templateConfig(template));
      const compiled = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot });
      const planner = compiled.agents.get('planner')!;
      expect(planner.tools.map(({ name }) => name)).toEqual(config.agents.planner!.capabilities.grants.flatMap((grant) => grant.tools));
      expect(toolCapabilityResources(planner.tools.find(({ name }) => name === 'write')!)).toEqual([
        { kind: 'workspace' },
        { kind: 'record', scopes: ['self'], patterns: ['status.md'] },
        { kind: 'record', scopes: ['children'], patterns: ['brief.md'] },
      ]);
      expect(agentCanWriteRecord(planner, parseRecordName('brief.md'))).toBe(false);
      expect(agentCanWriteRecord(planner, parseRecordName('status.md'))).toBe(true);
      expect(toolCapabilityResources(planner.tools.find(({ name }) => name === 'read')!))
        .toContainEqual({kind:'record',scopes:['all'],patterns:['*']});
      expect('recordWrites' in planner).toBe(false);
      expect('canCreateChildren' in planner).toBe(false);
      expect([...compiled.cardTypes.values()].every((type) => type.states.size > 0)).toBe(true);
      expect(Object.values(config.card_types).every((type) => type.workflow.format_version === 7)).toBe(true);
    },
  );

  it('derives framework writer eligibility within each selected tool and clause', () => {
    const base = compileProjectWorkflows(classic()).agents.get('planner')!;
    const writer = {...base, tools:[resolveRuntimeTool('card', 'write', [
      {kind:'record',scopes:['self'],patterns:['status.md']},
      {kind:'record',scopes:['children'],patterns:['brief.md']},
    ])]};
    expect(agentCanWriteRecord(writer, parseRecordName('brief.md'))).toBe(false);
    const custom = {...base, tools:[resolveRuntimeTool('card','edit',[
      {kind:'record',scopes:['self','descendants'],patterns:['brief.md']},
    ])]};
    expect(agentCanWriteRecord(custom, parseRecordName('brief.md'))).toBe(true);
  });

  it('derives create availability from the parent-target clause and existing type permissions', () => {
    const config = classic();
    const configured = config.agents.planner!.capabilities.grants.find((grant) => grant.tools.includes('create_card'))!;
    configured.resources = [{kind:'card',scopes:['children']}];
    const compiled = compileProjectWorkflows(config);
    const plan = compiled.cardTypes.get('project')!.states.get('node:plan')!;
    if (plan.kind !== 'node') throw new Error('Missing plan node.');
    expect([...plan.childCreationTypes]).toEqual([]);
    expect([...plan.childActivationTypes].length).toBeGreaterThan(0);
    configured.resources = [{kind:'card',scopes:['all']}];
    const allowed = compileProjectWorkflows(config).cardTypes.get('project')!;
    const allowedPlan = allowed.states.get('node:plan')!;
    if (allowedPlan.kind !== 'node') throw new Error('Missing plan node.');
    expect([...allowedPlan.childCreationTypes]).toEqual([...allowed.permittedChildTypes]);
  });

  it.each([
    ['global', 'read', [{kind:'record',scopes:['self'],patterns:['*']}]],
    ['global', 'get_card', [{kind:'card',scopes:['children']}]],
    ['global', 'get_card', [{kind:'card',scopes:['descendants']}]],
    ['card', 'get_card', [{kind:'record',scopes:['all'],patterns:['*']}]],
    ['card', 'read_record_version', [{kind:'workspace'}]],
    ['card', 'run_command', [{kind:'card',scopes:['self']}]],
    ['card', 'view_image', [{kind:'record',scopes:['self'],patterns:['*']}]],
    ['card', 'get_card', [{kind:'card',scopes:['all'],patterns:['brief.md']}]],
    ['card', 'get_card', [{kind:'card',scopes:['self','self']}]],
    ['card', 'read', [{kind:'record',scopes:['all'],patterns:['../brief.md']}]],
    ['card', 'write', [{kind:'record',scopes:['all'],patterns:['status.md','status.md']}]],
    ['card', 'get_card', [{kind:'card',scopes:['ancestor']}]],
  ] as const)('rejects invalid %s/%s clauses', (scope, name, resources) => {
    expect(() => resolveRuntimeTool(scope, name, resources as never)).toThrow();
  });

  it('distinguishes optional Webfetch destinations from required and targetless tools', () => {
    expect(resolveRuntimeTool('card', 'webfetch').resources).toEqual([]);
    expect(() => resolveRuntimeTool('card','write')).toThrow(/requires resources/);
    expect(() => resolveRuntimeTool('card','webfetch',[])).toThrow(/nonempty/);
    expect(() => resolveRuntimeTool('card','websearch',[])).toThrow(/targetless/);
    expect(() => resolveRuntimeTool('card','not_a_tool')).toThrow(/unknown tool/);
  });

  it('rejects old authority forms, duplicate tools, unknown versions and mixed inapplicable groups', () => {
    const config = classic();
    for (const key of ['tools','record_writes','can_create_children']) {
      const input = structuredClone(config);
      Object.assign(input.agents.planner!, {[key]: []});
      expect(effectiveSaivageConfigSchema.safeParse(input).success).toBe(false);
    }
    for (const grants of [[{tools:['websearch','websearch']}],[{tools:['websearch']},{tools:['websearch']}]])
      expect(agentCapabilitiesSchema.safeParse({format_version:1,grants}).success).toBe(false);
    expect(agentCapabilitiesSchema.safeParse({format_version:2,grants:[]}).success).toBe(false);
    config.agents.executor!.capabilities.grants = [{tools:['read','get_card'],resources:[{kind:'workspace'}]}];
    expect(() => compileProjectWorkflows(config)).toThrow(/does not support workspace/);
  });
});
