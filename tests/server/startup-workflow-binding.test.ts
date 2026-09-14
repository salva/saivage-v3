import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
  nodeResultToolDefinition,
  runtimeAgentBinding,
} from '../../src/runtime/card-process/card-process-config.js';
import { capabilityRequestForTools } from '../../src/agents/provider-capabilities.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

function config(): SaivageConfig {
  return structuredClone(TEST_SAIVAGE_CONFIG);
}

describe('startup workflow binding authority', () => {
  it('completes binding in production composition before actor-capable services are constructed', () => {
    const composition = readFileSync(new URL('../../src/server/composition/server-services.ts', import.meta.url), 'utf8');
    const binding = composition.indexOf('const workflows = bindRuntimeWorkflows(');
    expect(binding).toBeGreaterThan(-1);
    expect(binding).toBeLessThan(composition.indexOf('const cardStore = new CardService('));
    expect(binding).toBeLessThan(composition.indexOf('const runtimeApplication = createRuntimeApplication('));
  });

  it('freezes structural model expansion against later source-config mutation', () => {
    const source = config();
    source.models.routes.analyst = { candidates: ['test-model'], temperature: 0.2, max_tokens: 200 };
    source.models.equivalents = [['test-model', 'equivalent-model', 'failover-model']];
    source.models.failover = { 'test-model': ['failover-model'] };
    source.providers.test!.models = ['test-model', 'equivalent-model', 'failover-model', 'mutated-model'];
    const structural = compileProjectWorkflows(source);
    expect(structural.analyst.model.orderedModelIds).toEqual(['test-model', 'equivalent-model', 'failover-model']);

    source.models.routes.analyst = { candidates: ['mutated-model'], temperature: 0.9, max_tokens: 99 };
    source.models.equivalents = [];
    source.models.failover = {};
    const registry = new ProviderRegistry(source);
    const bound = bindRuntimeWorkflows(structural, new ModelRouter(registry), registry, source.compaction.context_utilization_fraction);

    expect(runtimeAgentBinding(bound, 'analyst').candidateChain.map((candidate) => candidate.model))
      .toEqual(['test-model', 'equivalent-model', 'failover-model']);
  });

  it('retains independent selected-global and card capability requests as distinct startup contracts', () => {
    const source = config();
    source.agents.analyst!.tools = [];
    source.agents.analyst!.skills = false;
    const structural = compileProjectWorkflows(source);
    const requests: unknown[] = [];
    const router = {
      resolveModels(modelIds: readonly string[], request: unknown) {
        requests.push(request);
        return [{ provider: 'test', account: null, model: modelIds[0]! }];
      },
    } as ModelRouter;
    const registry = new ProviderRegistry(source);
    const bound = bindRuntimeWorkflows(structural, router, registry, source.compaction.context_utilization_fraction);
    const analyst = runtimeAgentBinding(bound, 'analyst');
    const oversight = runtimeAgentBinding(bound, 'oversight');
    const planner = runtimeAgentBinding(bound, 'planner');

    expect(analyst.toolSet.names).toEqual([]);
    expect(analyst.capabilityRequest).toEqual({ requiresTools: false, requiresExclusiveToolChoice: true });
    expect(oversight.capabilityRequest).toEqual({ requiresTools: true, requiresExclusiveToolChoice: true });
    expect(planner.capabilityRequest).toEqual({ requiresTools: true, requiresExclusiveToolChoice: true });
    expect(requests[0]).toBe(analyst.capabilityRequest);
    expect(requests[1]).toBe(oversight.capabilityRequest);
    expect(requests[2]).toBe(planner.capabilityRequest);
    expect(planner.toolSet.names).not.toContain('emit_result');
    const project = bound.cardTypes.get('project')!;
    const terminal = nodeResultToolDefinition(project, 'node:plan');
    expect(terminal).toEqual(expect.objectContaining({ function: expect.objectContaining({ name: 'emit_result', parameters: expect.objectContaining({ required: ['outcome','summary'] }) }) }));
    expect(capabilityRequestForTools([...planner.toolSet.names,terminal])).toEqual(planner.capabilityRequest);
    expect(capabilityRequestForTools(analyst.toolSet.names)).toEqual(analyst.capabilityRequest);
  });

  it('discovers participant bindings in direct canonical state-table order and skips unused configured agents',()=>{
    const source=config();
    source.models.routes.unused={candidates:['missing-unused-model'],temperature:0,max_tokens:100};
    source.agents.unused={prompt:'executor',tools:[],model_route:'unused',skills:false,session:'card',can_create_children:false,record_writes:[]};
    const structural=compileProjectWorkflows(source);
    const order:string[]=[];
    const router={resolveModels(modelIds:readonly string[]){order.push(modelIds[0]!);return [{provider:'test',account:null,model:modelIds[0]!}];}} as unknown as ModelRouter;
    const registry=new ProviderRegistry(source);
    const bound=bindRuntimeWorkflows(structural,router,registry,source.compaction.context_utilization_fraction);
    expect([...bound.agentBindings.keys()]).toEqual(['analyst','oversight','planner','reviewer','executor']);
    expect(bound.agentBindings.has('unused')).toBe(false);
    expect(order).toEqual(['test-model','test-model','test-model','test-model','test-model']);
  });

  it('rejects a zero-operational-tool card participant when only a tool-unsupported model can serve it', () => {
    const source = config();
    source.models.routes.empty = { candidates: ['empty-model'], temperature: 0.2, max_tokens: 200 };
    source.agents.empty = { prompt: 'executor', tools: [], model_route: 'empty', skills: false, session: 'card', can_create_children: false,record_writes:['status.md'] };
    source.providers.test!.models = [...(source.providers.test!.models ?? []), 'empty-model'];
    source.providers.test!.modelCapabilities = { 'empty-model': { toolsMode: 'unsupported' } };
    source.card_types.code!.workflow.nodes.execute!.agent = 'empty';
    source.card_types.code!.workflow.notification_recipient = 'empty';
    source.card_types.code!.workflow.nodes.execute!.records = Object.fromEntries(
      Object.keys(source.card_types.code!.workflow.nodes.execute!.records).map((name) => [name, {mode:'continue',gate:'exists'}]),
    );
    const structural = compileProjectWorkflows(source);
    const requests: unknown[] = [];
    const providerRegistry = new ProviderRegistry(source);
    const router = new ModelRouter(providerRegistry);
    const recording = {
      resolveModels(modelIds: readonly string[], request: Parameters<ModelRouter['resolveModels']>[1]) {
        if (modelIds.includes('empty-model')) requests.push(request);
        return router.resolveModels(modelIds, request);
      },
    } as ModelRouter;

    expect(() => bindRuntimeWorkflows(structural, recording, providerRegistry, source.compaction.context_utilization_fraction)).toThrow("Agent 'empty' model route 'empty' has no capability-compatible configured provider candidate.");
    expect(requests).toEqual([{ requiresTools: true, requiresExclusiveToolChoice: true }]);
  });

  it('binds the maximum positive candidate capacity while preserving route order', () => {
    const source = config();
    source.models.routes.analyst = { candidates: ['small-model', 'large-model', 'output-ineligible-model', 'unknown-model'], temperature: 0, max_tokens: 4096 };
    source.providers.test!.models = ['test-model', 'small-model', 'large-model', 'output-ineligible-model'];
    source.providers.test!.modelCapabilities = {
      'small-model': { contextWindowTokens: 120_000, maxOutputTokens: 8_000 },
      'large-model': { contextWindowTokens: 1_050_000, maxOutputTokens: 8_000 },
      'output-ineligible-model': { contextWindowTokens: 2_000_000, maxOutputTokens: 1_000 },
    };
    source.providers.uncapped = { models: ['unknown-model'], capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native' } };
    const structural = compileProjectWorkflows(source);
    const registry = new ProviderRegistry(source);
    const bound = bindRuntimeWorkflows(structural, new ModelRouter(registry), registry, 0.8);
    const binding = runtimeAgentBinding(bound, 'analyst');
    expect(binding.candidateChain.map(({ model }) => model)).toEqual(['small-model', 'large-model', 'output-ineligible-model', 'unknown-model']);
    expect(binding.routeUsableInputTokens).toBe(835_904);
  });

  it('fails binding when a participating route has no candidate with positive usable input', () => {
    const source = config();
    source.models.routes.analyst = { candidates: ['uncapped-model'], temperature: 0, max_tokens: 4096 };
    source.providers = {
      uncapped: {
        models: ['uncapped-model'],
        capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native' },
      },
    };
    const structural = compileProjectWorkflows(source);
    const registry = new ProviderRegistry(source);
    expect(() => bindRuntimeWorkflows(structural, new ModelRouter(registry), registry, 0.8)).toThrow(/no configured candidate with positive usable input capacity/u);
  });
});
