import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
  nodeResultSchema,
  processNodeOutcomes,
} from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { projectWorkflowPresentation } from '../../../src/runtime/card-process/workflow-presentation-projection.js';
import {
  compileOperations,
  type OperationDefinition,
  type OperationPlugin,
} from '../../../src/runtime/card-process/operation-contract.js';
import { shellRunOperation } from '../../../src/runtime/card-process/shell-operation.js';
import {
  resolveExecutionInputs,
  selectOperationRoute,
} from '../../../src/runtime/card-process/operation-routing.js';

const inspect: OperationDefinition = {
  id: 'acme-analysis.inspect',
  provider: { kind: 'plugin', name: 'acme-analysis' },
  contractVersion: 1,
  bindings: ['node'],
  config: z.object({}).strict(),
  inputs: { scope: { type: 'string', enum: ['project'], workflow: true } },
  outcomes: {
    finished: {
      status: { type: 'string', enum: ['complete', 'partial'], workflow: true },
      count: { type: 'integer', min: 0, max: 1000, workflow: true },
      paths: { type: 'strings', workflow: false },
    },
  },
  retainFields: ['status', 'count'],
  async run() {
    return {
      outcome: 'finished',
      summary: 'Inspected.',
      values: { status: 'partial', count: 3, paths: ['private'] },
    };
  },
};
const plugin: OperationPlugin = { namespace: 'acme-analysis', operations: { inspect } };
function fixture() {
  const config = effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG));
  const workflow = config.card_types.code!.workflow;
  const execute = workflow.nodes.execute!;
  if (execute.execution.kind !== 'agent') throw new Error('Expected fixture agent.');
  const agent = execute.execution;
  workflow.nodes = {
    execute: { ...execute, edges: { ready: { target: { node: 'inspect' } } } },
    inspect: {
      execution: {
        kind: 'action',
        action: inspect.id,
        contract_version: 1,
        config: {},
        inputs: { scope: { literal: 'project' } },
      },
      records: { 'status.md': { mode: 'continue', gate: 'exists' } },
      edges: {
        finished: {
          cases: [
            {
              id: 'partial',
              when: { field: 'status', op: 'eq', value: 'partial' },
              target: { node: 'assess' },
              inputs: { findings: { output: 'count' } },
            },
            {
              id: 'findings',
              when: { field: 'count', op: 'gt', value: 0 },
              target: { node: 'repair' },
              inputs: { findings: { output: 'count' } },
            },
          ],
          otherwise: { target: { node: 'assess' }, inputs: { findings: { output: 'count' } } },
        },
      },
    },
    assess: {
      ...execute,
      execution: { ...agent, data_inputs: { findings: { type: 'integer', min: 0, max: 1000 } } },
    },
    repair: {
      ...execute,
      execution: { ...agent, data_inputs: { findings: { type: 'integer', min: 0, max: 1000 } } },
    },
  };
  return config;
}
function compile(config = fixture()) {
  return compileProjectWorkflows(config, { operationPlugins: [plugin] });
}

describe('workflow2 typed action compilation', () => {
  function stdoutFixture() {
    const config = effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG));
    const type = config.card_types.code!;
    type.records['check-report.md'] = { format: 'markdown', schema: 'check-report.v1', bootstrap: false };
    const old = type.workflow.nodes.execute!;
    type.workflow.nodes.assess = old;
    type.workflow.entries.STOPPED = { ...type.workflow.entries.STOPPED, node: 'assess' };
    type.workflow.nodes.execute = {
      execution: { kind: 'action', action: 'shell.run', contract_version: 1, config: { script: 'printf report' }, inputs: { args: { literal: [] } } },
      stdout_record: 'check-report.md',
      records: { 'check-report.md': { mode: 'continue', gate: 'updated' } },
      edges: Object.fromEntries(['passed', 'failed', 'signalled', 'timed_out'].map(outcome => [outcome, { target: { node: 'assess' } }])),
    };
    return config;
  }
  it('compiles exact shell stdout authority without granting agent record permissions', () => {
    const config = stdoutFixture();
    const workflow = compile(config).cardTypes.get('code')!;
    const node = workflow.states.get('node:execute')!;
    if (node.kind !== 'node') throw new Error('Expected node');
    expect(node.stdoutRecord).toMatchObject({ name: 'check-report.md', bootstrap: false, declared: true });
    expect(node.requirements).toMatchObject([{ definition: { name: 'check-report.md' }, mode: 'continue', gate: 'updated' }]);
    expect(projectWorkflowPresentation(workflow).nodes[0]).toMatchObject({ stdout_record: 'check-report.md' });
    expect(config.agents).toEqual(TEST_SAIVAGE_CONFIG.agents);
    expect(() => effectiveSaivageConfigSchema.parse({ ...config, card_types: { ...config.card_types, code: { ...config.card_types.code, workflow: { ...config.card_types.code!.workflow, format_version: 1 } } } })).toThrow();
  });
  it.each(['undeclared.md', 'brief.md', '*.md', 'record:///check-report.md?card=project', 'check-report'])('rejects invalid stdout destination %s', destination => {
    const config = stdoutFixture();
    config.card_types.code!.workflow.nodes.execute!.stdout_record = destination;
    expect(() => compile(effectiveSaivageConfigSchema.parse(config))).toThrow();
  });
  it.each(['missing', 'exists', 'clean', 'initialize'] as const)('requires exact continue/updated destination admission: %s', invalid => {
    const config = stdoutFixture(); const node = config.card_types.code!.workflow.nodes.execute!;
    if (invalid === 'missing') node.records = {};
    if (invalid === 'exists') node.records['check-report.md']!.gate = 'exists';
    if (invalid === 'clean') node.records['check-report.md']!.mode = 'clean';
    if (invalid === 'initialize') node.initialize_records = ['check-report.md'];
    expect(() => compile(config)).toThrow();
  });
  it('rejects stdout authority on agents, plugins and hooks while leaving unbound requirements narrow', () => {
    const agent = stdoutFixture();
    agent.card_types.code!.workflow.nodes.execute!.execution = structuredClone(TEST_SAIVAGE_CONFIG.card_types.code!.workflow.nodes.execute!.execution);
    expect(() => compile(agent)).toThrow(/requires shell.run/);
    const other = fixture(); other.card_types.code!.workflow.nodes.inspect!.stdout_record = 'status.md';
    expect(() => compile(other)).toThrow(/requires shell.run/);
    const hook = stdoutFixture();
    const node = hook.card_types.code!.workflow.nodes.execute!;
    hook.card_types.code!.workflow.after_activation_commit = { statuses: ['done'], execution: node.execution as Extract<typeof node.execution, { kind: 'action' }> };
    const raw = hook as unknown as { card_types: { code: { workflow: { after_activation_commit: Record<string, unknown> } } } };
    raw.card_types.code.workflow.after_activation_commit.stdout_record = 'check-report.md';
    expect(() => effectiveSaivageConfigSchema.parse(hook)).toThrow();
    const unbound = stdoutFixture(); delete unbound.card_types.code!.workflow.nodes.execute!.stdout_record;
    expect(() => compile(unbound)).toThrow(/continue\/exists/);
    unbound.card_types.code!.workflow.nodes.execute!.records['check-report.md']!.gate = 'exists';
    expect(() => compile(unbound)).not.toThrow();
  });
  it('projects exact action identity and distinct typed branches without agent bindings or executable config disclosure', () => {
    const config = fixture(),
      compiled = compile(config),
      registry = new ProviderRegistry(config);
    const bound = bindRuntimeWorkflows(
      compiled,
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
    );
    const graph = projectCompiledGraphs(bound).graphs.find(
      ({ card_type }) => card_type === 'code',
    )!;
    const presentation = projectWorkflowPresentation(compiled.cardTypes.get('code')!);
    const identity = {
      kind: 'action',
      action: 'acme-analysis.inspect',
      contract_version: 1,
      provider: { kind: 'plugin', name: 'acme-analysis' },
    };
    expect(graph.nodes.find(({ node_id }) => node_id === 'inspect')!.execution).toEqual(identity);
    expect(graph.nodes.find(({ node_id }) => node_id === 'inspect')!.outcomes).toEqual([
      'finished',
    ]);
    expect(presentation.nodes.find(({ node_id }) => node_id === 'inspect')!.execution).toEqual(
      identity,
    );
    const edges = graph.edges.filter(
      (edge) => edge.source_node_id === 'inspect' && edge.outcome === 'finished',
    );
    expect(edges.map(({ route_id }) => route_id)).toEqual([
      'finished:case:partial',
      'finished:case:findings',
      'finished:otherwise',
    ]);
    expect(edges[0]!.test).toEqual({ field: 'status', op: 'eq', value: 'partial' });
    expect(edges[1]!.test).toEqual({ field: 'count', op: 'gt', value: 0 });
    expect(edges[2]!.test).toBeNull();
    expect(
      presentation.edges
        .filter((edge) => edge.source_node_id === 'inspect' && edge.outcome === 'finished')
        .map(({ route_id, test }) => ({ route_id, test })),
    ).toEqual(edges.map(({ route_id, test }) => ({ route_id, test })));
    expect([...bound.agentBindings.keys()]).not.toContain('acme-analysis.inspect');
    expect(
      Object.keys(graph.nodes.find(({ node_id }) => node_id === 'inspect')!.execution),
    ).not.toContain('config');
  });
  it('redacts public case literals without changing the compiled route decision', () => {
    const config = fixture();
    const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
    if (!('cases' in edge)) throw new Error('Expected cases.');
    edge.cases[0]!.when.value = 'api_key=projection-canary';
    const definition: OperationDefinition = {
      ...inspect,
      outcomes: {
        finished: { ...inspect.outcomes.finished, status: { type: 'string', workflow: true } },
      },
    };
    const compiled = compileProjectWorkflows(config, {
      operationPlugins: [{ namespace: 'acme-analysis', operations: { inspect: definition } }],
    });
    const workflow = compiled.cardTypes.get('code')!;
    expect(
      workflow.states.get('node:inspect')!.on.get('result:finished:case:partial')!.semantic,
    ).toMatchObject({ test: { value: 'api_key=projection-canary' } });
    const registry = new ProviderRegistry(config);
    const graphs = projectCompiledGraphs(
      bindRuntimeWorkflows(
        compiled,
        new ModelRouter(registry),
        registry,
        config.compaction.context_utilization_fraction,
      ),
    );
    expect(JSON.stringify(graphs)).not.toContain('projection-canary');
    expect(JSON.stringify(projectWorkflowPresentation(workflow))).not.toContain(
      'projection-canary',
    );
  });
  it('compiles real plugin cases into distinct events while preserving outcomes and binding selected values', () => {
    const compiled = compile();
    const workflow = compiled.cardTypes.get('code')!;
    const node = workflow.states.get('node:inspect')!;
    if (node.kind !== 'node' || node.execution.kind !== 'action')
      throw new Error('Expected action.');
    expect(processNodeOutcomes(workflow, 'node:inspect')).toEqual(['finished']);
    expect([...node.on.keys()]).toContain('result:finished:case:partial');
    const routes = [...node.on.values()].flatMap(({ semantic }) =>
      semantic.kind === 'configured-outcome' ? [semantic] : [],
    );
    const selected = selectOperationRoute(node.execution, routes, {
      outcome: 'finished',
      summary: 'Observed.',
      values: { status: 'partial', count: 3, paths: ['private'] },
    });
    expect(selected.routeId).toBe('finished:case:partial');
    const target = workflow.states.get('node:assess')!;
    if (target.kind !== 'node' || target.execution.kind !== 'agent')
      throw new Error('Expected agent.');
    expect(
      resolveExecutionInputs(
        target.execution.dataInputs,
        target.execution.inputs,
        routes[0]!.inputs,
        selected.result.values,
        { card_id: 'card-a', card_type: 'code', card_title: 'Check' },
      ),
    ).toEqual({ findings: 3 });
    expect(
      nodeResultSchema(workflow, 'node:assess').safeParse({ outcome: 'done', summary: 'Complete.' })
        .success,
    ).toBe(true);
    expect(
      nodeResultSchema(workflow, 'node:assess').safeParse({
        outcome: 'finished:case:partial',
        summary: 'Wrong.',
      }).success,
    ).toBe(false);
  });
  it('rejects exact identity/version/provider collisions without discovery or aliases', () => {
    for (const id of ['inspect', 'Shell.run', 'shell.run.extra', 'shell_run']) {
      const config = fixture();
      const node = config.card_types.code!.workflow.nodes.inspect!;
      if (node.execution.kind !== 'action') throw new Error('Expected action.');
      node.execution.action = id;
      expect(() => compile(config)).toThrow();
    }
    expect(() => compileOperations([shellRunOperation, shellRunOperation])).toThrow(
      /Duplicate operation/,
    );
    expect(() => compileOperations([shellRunOperation], [plugin, plugin])).toThrow(
      /duplicate operation namespace/,
    );
    expect(() => compileOperations([], [{ namespace: 'git', operations: {} }])).toThrow(/Reserved/);
    expect(() => compileOperations([], [{ namespace: 'other', operations: { inspect } }])).toThrow(
      /identity/,
    );
    const config = fixture();
    const node = config.card_types.code!.workflow.nodes.inspect!;
    if (node.execution.kind !== 'action') throw new Error('Expected action.');
    node.execution.action = 'git.commit';
    expect(() => compile(config)).toThrow(/Unresolved/);
  });
  it('checks every branch, safe fields, complete inputs, recipient gates and action record restrictions', () => {
    const invalid: Array<(config: ReturnType<typeof fixture>) => void> = [
      (config) => {
        config.card_types.code!.workflow.nodes.inspect!.records['status.md']!.mode = 'clean';
      },
      (config) => {
        config.card_types.code!.workflow.nodes.inspect!.records['status.md']!.gate = 'updated';
      },
      (config) => {
        config.card_types.code!.workflow.nodes.inspect!.initialize_records = [];
      },
      (config) => {
        config.card_types.code!.workflow.entries.STOPPED.node = 'inspect';
      },
      (config) => {
        config.card_types.code!.workflow.nodes.execute!.edges.ready = {
          target: { node: 'inspect' },
          prompt: { reference: 'execute', compactable: true },
        };
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.cases[0]!.when.field = 'paths';
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.cases[0]!.when.op = 'gt';
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.cases[1]!.id = 'partial';
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.otherwise.target = { node: 'missing' };
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.otherwise.inputs = {};
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.otherwise.inputs = { findings: { output: 'paths' } };
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.otherwise = {
          target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] },
        };
      },
      (config) => {
        const edge = config.card_types.code!.workflow.nodes.inspect!.edges.finished!;
        if (!('cases' in edge)) throw new Error();
        edge.otherwise = {
          target: {
            terminal: 'BLOCKED',
            promote: { latest_node: 'missing' },
            export_records: ['status.md'],
          },
        };
      },
      (config) => {
        const node = config.card_types.code!.workflow.nodes.assess!;
        if (node.execution.kind !== 'agent') throw new Error();
        node.execution.inputs = { findings: { literal: 1 } };
      },
    ];
    for (const change of invalid) {
      const config = fixture();
      change(config);
      expect(() => compile(config)).toThrow();
    }
  });
  it('requires all four shell outcomes and compiles only supported hook bindings', () => {
    const config = fixture();
    const workflow = config.card_types.code!.workflow;
    const node = workflow.nodes.inspect!;
    node.execution = {
      kind: 'action',
      action: 'shell.run',
      contract_version: 1,
      config: { script: 'printf "%s" "$@"' },
      inputs: { args: { literal: [] } },
    };
    node.edges = Object.fromEntries(
      ['passed', 'failed', 'signalled', 'timed_out'].map((outcome) => [
        outcome,
        { target: { node: 'execute' } },
      ]),
    );
    delete workflow.nodes.assess;
    delete workflow.nodes.repair;
    workflow.nodes.execute!.edges.blocked = {
      target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] },
    };
    workflow.after_activation_commit = { statuses: ['done'], execution: { ...node.execution } };
    expect(
      compile(config).cardTypes.get('code')!.afterActivationCommit?.execution.operation.id,
    ).toBe('shell.run');
    workflow.after_activation_commit.execution = {
      kind: 'action',
      action: inspect.id,
      contract_version: 1,
      config: {},
      inputs: { scope: { literal: 'project' } },
    };
    expect(() => compile(config)).toThrow(/does not support/);
    delete workflow.after_activation_commit;
    delete node.edges.signalled;
    expect(() => compile(config)).toThrow(/every exact operation outcome/);
  });
  it('strictly rejects old source config, unsupported fields and incomplete operation returns', () => {
    const old = structuredClone(DEFAULT_SAIVAGE_CONFIG) as unknown as {
      card_types: { code: { workflow: Record<string, unknown> } };
    };
    delete old.card_types.code.workflow.format_version;
    expect(effectiveSaivageConfigSchema.safeParse(old).success).toBe(false);
    const workflow = compile().cardTypes.get('code')!;
    const node = workflow.states.get('node:inspect')!;
    if (node.kind !== 'node' || node.execution.kind !== 'action') throw new Error();
    const routes = [...node.on.values()].flatMap(({ semantic }) =>
      semantic.kind === 'configured-outcome' ? [semantic] : [],
    );
    expect(() =>
      selectOperationRoute(
        node.execution as Extract<typeof node.execution, { kind: 'action' }>,
        routes,
        {
          outcome: 'finished',
          summary: 'Effect happened.',
          values: { status: 'partial', paths: [] },
        },
      ),
    ).toThrow();
  });
});
