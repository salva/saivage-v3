import { expect, it } from '@jest/globals';
import { effectiveSaivageConfigSchema, outboundEffectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { qualityToolBindingsSchema } from '../../src/schemas/quality-operation-config.js';
import { projectEffectiveConfigForOutbound } from '../../src/config/effective-config-outbound.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const name = 'code_quality_javascript_eslint';
const binding = { cwd: '.', native_config: 'analysis/private-config.mjs', source_paths: ['src'],
  exclusions: [], timeout_ms: 30000, terminate_grace_ms: 2000,
  node_binary: '/opt/private-node/bin/node', eslint_module: 'analysis/node_modules/eslint' };
const qualityTools = { format_version: 1 as const, [name]: binding };

it('requires a nonempty exact versioned binding and the paired selected grant', () => {
  for (const invalid of [{ format_version: 1 }, { ...qualityTools, format_version: 2 },
    { ...qualityTools, extra: binding }, { ...qualityTools, [name]: { ...binding, script: 'echo bad' } }])
    expect(qualityToolBindingsSchema.safeParse(invalid).success).toBe(false);
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  const agent = config.agents[config.analyst_agent]!;
  agent.quality_tools = qualityTools;
  expect(effectiveSaivageConfigSchema.safeParse(config).success).toBe(false);
  agent.tools.push(name);
  expect(effectiveSaivageConfigSchema.parse(config).agents[config.analyst_agent]!.quality_tools).toEqual(qualityTools);
  delete agent.quality_tools;
  expect(effectiveSaivageConfigSchema.safeParse(config).success).toBe(false);
});

it('omits the entire provisioning section outbound while retaining selected names', () => {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  const agent = config.agents[config.analyst_agent]!;
  agent.tools.push(name);
  agent.quality_tools = qualityTools;
  const outbound = projectEffectiveConfigForOutbound(effectiveSaivageConfigSchema.parse(config));
  expect(outbound.agents[config.analyst_agent]!.tools).toContain(name);
  expect(outbound.agents[config.analyst_agent]).not.toHaveProperty('quality_tools');
  for (const value of [binding.node_binary, binding.native_config, binding.eslint_module])
    expect(JSON.stringify(outbound)).not.toContain(value);
  expect(outboundEffectiveSaivageConfigSchema.safeParse({ ...outbound,
    agents: { ...outbound.agents, [config.analyst_agent]: { ...outbound.agents[config.analyst_agent], quality_tools: qualityTools } },
  }).success).toBe(false);
});
