import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeSystemTemplate, resolveSystemTemplate, DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { syntheticGitProvisioning, templateConfig } from '../helpers/system-template-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows, describeNodeResultContract, processNodeOutcomes } from '../../src/runtime/card-process/card-process-config.js';
import { renderCompiledPrompt } from '../../src/utils/prompt-api.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const template = resolveSystemTemplate('classic-git');
describe('provisioned native classic bundle', () => {
  it('requires real inputs, preserves OFF, compiles and binds all actual correction participants', () => {
    expect('config' in template).toBe(false);
    expect(() => materializeSystemTemplate(template)).toThrow('all four');
    expect(() => materializeSystemTemplate(resolveSystemTemplate('classic'), syntheticGitProvisioning)).toThrow('OFF');
    const config = effectiveSaivageConfigSchema.parse(templateConfig(template));
    config.models = structuredClone(TEST_SAIVAGE_CONFIG.models);
    config.providers = structuredClone(TEST_SAIVAGE_CONFIG.providers);
    config.providers.test!.capabilities!.imageInput = true;
    config.providers.test!.capabilities!.transportProtocol = 'openai-responses';
    config.compaction = structuredClone(TEST_SAIVAGE_CONFIG.compaction);
    const compiled = compileProjectWorkflows(config);
    const registry = new ProviderRegistry(config);
    const bound = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry,
      config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
    expect(bound.gitPolicy).toEqual(compiled.gitPolicy);
    expect(compiled.analyst.tools.map(tool => tool.name)).not.toContain('run_command');
    expect(compiled.agents.get('executor')!.tools.map(tool => tool.name)).toContain('checkpoint_source');
    expect(compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG).gitPolicy).toBeNull();
    const renders: Record<string, string> = {};
    for (const [cardType, workflow] of compiled.cardTypes) {
      const correction = workflow.states.get('node:git-rebase-correction')!;
      if (correction.kind !== 'node' || correction.execution.kind !== 'agent') throw new Error('Missing correction');
      expect(correction.execution.agent.name).toBe('executor');
      expect(correction.requirements).toEqual([]);
      expect(processNodeOutcomes(workflow, 'node:git-rebase-correction')).toEqual(['source_ready', 'blocked', 'failed']);
      expect(workflow.records.get('git-correction.md')!.bootstrap).toBe(false);
      for (const [stateId, state] of workflow.states) {
        if (state.kind !== 'node' || state.execution.kind !== 'agent') continue;
        const contract = describeNodeResultContract(workflow, stateId);
        const role = renderCompiledPrompt({kind:'workflow-agent', cardType}, state.execution.agent.name,
          state.execution.selectedAgentPrompt.compiled, {contractDescription: contract});
        const task = workflow.processPrompts.get(state.execution.prompt.promptId)!.text;
        const feedback = workflow.processPrompts.get(state.execution.correctionPrompt.promptId)!.text;
        renders[`${cardType}/${state.nodeId}`] = `${role}\n\n${task}\n\n[Rejected-result feedback, when applicable]\n${feedback}`;
        expect(role.includes('{{')).toBe(false);
        expect(role.split(contract)).toHaveLength(2);
      }
    }
    for (const [name, participant] of compiled.selectedGlobalParticipants) {
      renders[`global/${name}`] = renderCompiledPrompt({kind:'global-agent'}, name,
        participant.prompt.compiled, {vocabularySnippet:'Synthetic card vocabulary: project, goal, code.'});
    }
    const output = mkdtempSync(join(tmpdir(), 'native-bundle-renders-'));
    writeFileSync(join(output, 'compiled-renders.json'), JSON.stringify(renders, null, 2));
  });

  it('accepts selected custom guidance, but refuses replacement hosts dropping native capability context', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-bundle-override-'));
    const fragments = join(root, '.saivage/config/prompts/fragments/_shared');
    const agents = join(root, '.saivage/config/prompts/agents/_shared');
    mkdirSync(fragments, {recursive:true}); mkdirSync(agents, {recursive:true});
    writeFileSync(join(fragments, 'project-guidance-executor.md'), 'Synthetic project requirement: preserve the documented test oracle.');
    const config = effectiveSaivageConfigSchema.parse(templateConfig(template));
    const compiled = compileProjectWorkflows(config, {projectRoot:root});
    const execution = compiled.cardTypes.get('project')!.states.get('node:git-rebase-correction')!;
    if (execution.kind !== 'node' || execution.execution.kind !== 'agent') throw new Error('Missing correction');
    const rendered = renderCompiledPrompt({kind:'workflow-agent',cardType:'project'}, 'executor', execution.execution.selectedAgentPrompt.compiled, {contractDescription:'Synthetic contract'});
    expect(rendered).toContain('preserve the documented test oracle');
    const host = readFileSync(join(template.promptRoot,'agents/_shared/executor.md'),'utf8');
    writeFileSync(join(agents,'executor.md'), host.replace('{{>native-source}}',''));
    expect(() => compileProjectWorkflows(config,{projectRoot:root})).toThrow('native-source');
    writeFileSync(join(agents,'executor.md'), host);
    expect(() => compileProjectWorkflows(config,{projectRoot:root})).not.toThrow();
  });
});
