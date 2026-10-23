import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservedCollections } from '../../src/retrieval/observed-collections.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, resolveRuntimeTool, type RuntimeToolBindingContext } from '../../src/tools/runtime-tool-catalog.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { ToolResultSchema } from '../../src/contracts/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('configured observed source tool surfaces', () => {
  it('preserves a narrowed executor grant through actual compiled card nodes and leaves Oversight unchanged', () => {
    const config=structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents.executor!.tools=config.agents.executor!.tools.filter(name=>name!=='query_observed_collections');
    const compiled=compileProjectWorkflows(config);
    let nodes=0;
    for(const workflow of compiled.cardTypes.values()) for(const state of workflow.states.values()) {
      if(state.kind!=='node'||state.execution.kind!=='agent'||state.execution.agent.name!=='executor')continue;
      const refs=effectiveCardNodeToolReferences(state.execution.agent.tools,state.childCreationTypes);
      expect(refs.some(ref=>ref.name==='list_observed_collections')).toBe(true);
      expect(refs.some(ref=>ref.name==='query_observed_collections')).toBe(false);
      nodes++;
    }
    expect(nodes).toBeGreaterThan(0);
    expect(compiled.oversight.tools.some(ref=>ref.name==='list_observed_collections'||ref.name==='query_observed_collections')).toBe(false);
  });
  it.each(['global', 'card'] as const)('binds actual %s policy without adding a conversation or canonical record observations', async (scope) => {
    const root = mkdtempSync(join(tmpdir(), 'retrieval-surface-')); roots.push(root);
    // Only the selected provider group is constructed; absent definitions exercise
    // the real disabled owner without a native server or synthetic data port.
    const runtime = { scope, agentName: scope === 'global' ? 'analyst' : 'executor', projectRoot: root,
      retrieval: createObservedCollections(root), store: {} } as RuntimeToolBindingContext;
    const surface = new BoundAgentToolSet([resolveRuntimeTool(scope, 'list_observed_collections')]).bind(runtime);
    expect(new BoundAgentToolSet([]).bind(runtime).tools.has('list_observed_collections')).toBe(false);
    const tool = surface.tools.get('list_observed_collections')!;
    expect(tool.resultPolicyTemplate.evidenceMode).toBe('observational_query');
    const signal = new AbortController().signal;
    const result = await tool.executor(tool.inputSchema.parse({}), signal,
      { kind: 'external', invocationId: '34d58cb4-b7dc-43f1-bb39-8acdc1a54fde', principal: 'fixture', signal });
    expect(result.providerOutcome.kind).toBe('succeeded');
    expect(result.providerOutcome).not.toHaveProperty('record_observations');
    expect(result.evidence.kind).toBe('observational_result_bytes');
    const retained = ToolResultSchema.parse({ success: true, data: result.providerOutcome.data });
    expect(retained.data).toMatchObject({ collections: [], hits: [], coverage: { exhaustive: false } });
  });
});
