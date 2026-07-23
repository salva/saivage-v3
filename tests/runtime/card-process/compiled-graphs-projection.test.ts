import { describe, expect, it } from '@jest/globals';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { createTestConfigAuthority } from '../../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('compiled Debug graph projection', () => {
  it('remains the startup projection after restart-only reconfiguration and changes only with a fresh artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-graphs-reconfigure-'));
    try {
      const authority = createTestConfigAuthority(root);
      const current = authority.loadEffective();
      const bind = (effective: typeof current) => bindRuntimeWorkflows(effective.workflows, new ModelRouter(effective.config, new ProviderRegistry(effective.config)));
      const startup = bind(current);
      const before = projectCompiledGraphs(startup);
      expect(authority.applyChange({ kind: 'set_agent_model_route', agent: 'planner', modelRoute: 'executor' })).toMatchObject({ success: true, requires_restart: true });
      expect(projectCompiledGraphs(startup)).toEqual(before);
      expect(before.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.agent_name === 'planner')!.model.route).toBe('planner');
      const afterRestart = projectCompiledGraphs(bind(authority.loadEffective()));
      expect(afterRestart.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.agent_name === 'planner')!.model.route).toBe('executor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects cycles, terminal exports and runtime-owned failures without prompt bodies or account identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-graphs-shape-'));
    try {
      const effective = createTestConfigAuthority(root, { config: TEST_SAIVAGE_CONFIG }).loadEffective();
      const workflows = bindRuntimeWorkflows(effective.workflows, new ModelRouter(effective.config, new ProviderRegistry(effective.config)));
      const graph = projectCompiledGraphs(workflows).graphs.find((candidate) => candidate.card_type === 'project')!;
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_node_id: 'review', outcome: 'revision_required', target: { kind: 'node', node_id: 'plan' } }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'approved', export_records: ['review.md'], promotion: { kind: 'current' } }),
        expect.objectContaining({ source_node_id: 'plan', outcome: 'execution:failed', runtime_owned: true, target: { kind: 'terminal', terminal: 'FAILED' } }),
      ]));
      expect(JSON.stringify(graph)).not.toMatch(/prompt body|account|contractDescription|\.saivage/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
