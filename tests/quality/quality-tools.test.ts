import { expect, it } from '@jest/globals';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { BoundAgentToolSet } from '../../src/tools/runtime-tool-catalog.js';
import { invokeTool } from '../../src/tools/invocation.js';
import type { GlobalToolBindingContext } from '../../src/tools/runtime-tool-catalog.js';

const name = 'code_quality_javascript_eslint';
const config = { cwd: '.', native_config: 'eslint.config.mjs', source_paths: ['src'], exclusions: [],
  node_binary: '/opt/node/bin/node', eslint_module: 'node_modules/eslint', timeout_ms: 30000, terminate_grace_ms: 100 };

it('compiles independent frozen policy-agent bindings without default grants', () => {
  const source = structuredClone(TEST_SAIVAGE_CONFIG);
  const baseline = compileProjectWorkflows(source);
  expect([...baseline.agents.values()].every((agent) => !agent.tools.some((tool) => tool.name === name))).toBe(true);
  const keys = Object.keys(source.agents).filter((key) => source.agents[key]!.session === 'card').slice(0, 2);
  expect(keys).toHaveLength(2);
  for (const [index, key] of keys.entries()) {
    source.agents[key]!.tools.push(name);
    source.agents[key]!.quality_tools = { format_version: 1,
      [name]: { ...config, source_paths: [`source-${index}`] } };
  }
  const compiled = compileProjectWorkflows(source);
  for (const [index, key] of keys.entries()) {
    const agent = [...compiled.agents.values()].find((agent) => agent.name === key)!;
    expect(agent.qualityTools?.[name]?.source_paths).toEqual([`source-${index}`]);
    expect(Object.isFrozen(agent.qualityTools?.[name]?.source_paths)).toBe(true);
    source.agents[key]!.quality_tools![name]!.source_paths.push('later');
    expect(agent.qualityTools?.[name]?.source_paths).toEqual([`source-${index}`]);
  }
});

it('rejects request substitution and unselected tools before entering the runtime port', async () => {
  const source = structuredClone(TEST_SAIVAGE_CONFIG);
  source.agents[source.analyst_agent]!.tools.push(name);
  source.agents[source.analyst_agent]!.quality_tools = { format_version: 1, [name]: config };
  const workflows = compileProjectWorkflows(source);
  let entered = 0;
  // No workspace/process access is available in this admission-only witness.
  const context = { scope: 'global', agentName: workflows.analyst.name,
    projectRoot: '/unavailable-quality-admission-fixture', quality: { async invoke() { entered++; throw new Error('entered'); } },
  } as unknown as GlobalToolBindingContext;
  const surface = new BoundAgentToolSet(workflows.analyst.tools.filter((tool) => tool.name === name)).bind(context);
  const invocation = { kind: 'external' as const, invocationId: 'quality-request-test', principal: 'external-fixture',
    signal: new AbortController().signal };
  for (const args of [{ node_binary: '/other/node' }, { native_config: 'other' }, { source_paths: ['other'] },
    { operation: 'shell.run' }, { argv: [] }, { output_record: 'status.md' }, { agent: 'other' }]) {
    expect((await invokeTool(surface, name, args, invocation)).kind).toBe('rejected_before_execution');
  }
  expect((await invokeTool(surface, 'code_quality_python_ruff', {}, invocation)).kind).toBe('unsupported_tool');
  expect(entered).toBe(0);
  await expect(invokeTool(surface, name, {}, invocation)).rejects.toThrow('entered');
  expect(entered).toBe(1);
});
