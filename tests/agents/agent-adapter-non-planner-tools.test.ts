import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentAdapter, type AgentRole } from '../../src/agents/agent-adapter.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/agents/analyst-tool-schemas.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-llm-resolver.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

const NON_PLANNER_AGENT_ROLES: AgentRole[] = ['analyst', 'executor', 'reviewer'];
const MATRIX_DOC = join(process.cwd(), 'docs', 'agents.md');

function createMinimalAdapter(): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as SaivageConfig;

  return new AgentAdapter({
    projectRoot: process.cwd(),
    saivageDir: join(process.cwd(), '.saivage'),
    config: minimalConfig,
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function extractAgentToolMatrix(): Map<string, string[]> {
  const docs = readFileSync(MATRIX_DOC, 'utf-8');
  const section = docs.match(/<!-- saivage:agent-tools:start -->(?<body>[\s\S]*?)<!-- saivage:agent-tools:end -->/);
  if (!section?.groups?.body) throw new Error('Unable to find docs/agents.md source-verified agent tool matrix block.');

  const rows = new Map<string, string[]>();
  for (const match of section.groups.body.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm)) {
    const [, role, tools] = match;
    rows.set(role, uniqueSorted(tools.split(',').map((toolName) => toolName.trim()).filter(Boolean)));
  }
  return rows;
}

function toolRuntimeDefinitionNames(): string[] {
  const source = readFileSync(join(process.cwd(), 'src', 'tools', 'agent-tools.ts'), 'utf-8');
  return uniqueSorted([
    ...source.matchAll(/name: '([a-z_]+)'/g),
  ].map((entry) => entry[1]));
}

function functionToolDefinitions(source: string, exportedConstantName: string): string[] {
  const match = source.match(new RegExp(`export const ${exportedConstantName}[^=]*= \\[([\\s\\S]*?)\\n\\];`));
  if (!match) throw new Error(`Unable to find ${exportedConstantName} in source.`);
  return uniqueSorted([...match[1].matchAll(/tool\('([a-z_]+)'/g)].map((entry) => entry[1]));
}

function processToolCallRoutedToolNames(): string[] {
  const adapterSource = readFileSync(join(process.cwd(), 'src', 'agents', 'agent-adapter.ts'), 'utf-8');
  const workspaceSource = readFileSync(join(process.cwd(), 'src', 'agents', 'workspace-tools.ts'), 'utf-8');
  const skillSource = readFileSync(join(process.cwd(), 'src', 'agents', 'skill-tools.ts'), 'utf-8');

  const runtimeAgentTools = toolRuntimeDefinitionNames();
  const workspaceTools = [...workspaceSource.matchAll(/name: '([a-z_]+)'/g)].map((match) => match[1]);
  const explicitlyHandled = [...adapterSource.matchAll(/tc\.function\.name (?:===|!==) '([a-z_]+)'/g)].map((match) => match[1]);
  const switchCases = [...adapterSource.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
  const skillTools = [...skillSource.matchAll(/name:\s*'([a-z_]+)'/g)].map((match) => match[1]);

  return uniqueSorted([...runtimeAgentTools, ...workspaceTools.filter((name) => explicitlyHandled.includes(name)), ...switchCases, ...skillTools, 'mcp_tool_call']);
}

describe('AgentAdapter non-planner tool surface parity', () => {
  it('matches documented analyst/executor/reviewer tool matrices to exported AgentAdapter definitions', () => {
    const docsMatrix = extractAgentToolMatrix();
    const adapter = createMinimalAdapter();

    for (const role of NON_PLANNER_AGENT_ROLES) {
      const documented = docsMatrix.get(role);
      expect(documented).toBeDefined();
      expect(documented).toEqual(uniqueSorted(adapter.getToolNamesForRole(role)));
    }
  });

  it('matches documented card-scoped analyst tools to web analyst definitions and handler routing', () => {
    const docsMatrix = extractAgentToolMatrix();
    const documented = docsMatrix.get('card-scoped analyst');
    const exported = uniqueSorted(ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name));
    const routed = uniqueSorted(Object.keys(TOOL_REGISTRY));

    expect(documented).toBeDefined();
    expect(documented).toEqual(exported);
    expect(routed).toEqual(exported);
  });

  it('routes every exported non-planner AgentAdapter public tool through processToolCall', () => {
    const adapter = createMinimalAdapter();
    const routedTools = processToolCallRoutedToolNames();

    for (const role of NON_PLANNER_AGENT_ROLES) {
      expect(routedTools).toEqual(expect.arrayContaining(adapter.getToolNamesForRole(role)));
    }
  });

  it('keeps analyst schema definitions routed by the card-scoped analyst handler', () => {
    const schemaSource = readFileSync(join(process.cwd(), 'src', 'agents', 'analyst-tool-schemas.ts'), 'utf-8');
    const sourceDefinitions = functionToolDefinitions(schemaSource, 'ANALYST_TOOL_DEFINITIONS');
    expect(uniqueSorted(Object.keys(TOOL_REGISTRY))).toEqual(sourceDefinitions);
  });
});
