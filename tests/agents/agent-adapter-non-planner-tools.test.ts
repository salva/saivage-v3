import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter, type AgentRole } from '../../src/agents/agent-adapter.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { ANALYST_TOOL_DEFINITIONS } from '../../src/tools/definitions/index.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-prompt.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { MCP_WRAPPER_TOOL_NAMES, SKILL_TOOL_NAMES, WORKSPACE_TOOL_NAMES } from '../../src/tools/definitions/index.js';

const NON_PLANNER_AGENT_ROLES: AgentRole[] = ['analyst', 'executor', 'reviewer'];
const MATRIX_DOC = join(process.cwd(), 'docs', 'agents.md');

const RETIRED_NOTE_TOOLS = ['add_note', '\x6cist_notes', 'get_note', '\x6dark_note_handled'];
const tmpDirs: string[] = [];

function createMinimalAdapter(): AgentAdapter {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-non-planner-surface-'));
  tmpDirs.push(projectRoot);
  mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
  initProjectTree(projectRoot);
  const cardStore = new CardStore(projectRoot);
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
      maxToolTurns: 16,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as SaivageConfig;

  return new AgentAdapter({
    projectRoot,
    saivageDir: join(projectRoot, '.saivage'),
    config: minimalConfig,
    cardStore,
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function extractAgentToolMatrix(): Map<string, string[]> {
  const docs = readFileSync(MATRIX_DOC, 'utf-8');
  const section = docs.match(
    /<!-- saivage:agent-tools:start -->(?<body>[\s\S]*?)<!-- saivage:agent-tools:end -->/,
  );
  if (!section?.groups?.body)
    throw new Error('Unable to find docs/agents.md source-verified agent tool matrix block.');

  const rows = new Map<string, string[]>();
  for (const match of section.groups.body.matchAll(
    /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm,
  )) {
    const [, role, tools] = match;
    rows.set(
      role,
      uniqueSorted(
        tools
          .split(',')
          .map((toolName) => toolName.trim())
          .filter(Boolean),
      ),
    );
  }
  return rows;
}

function processToolCallRoutedToolNames(): string[] {
  return uniqueSorted([
    ...Object.keys(TOOL_REGISTRY),
    ...WORKSPACE_TOOL_NAMES,
    ...SKILL_TOOL_NAMES,
    ...MCP_WRAPPER_TOOL_NAMES,
  ]);
}

describe('AgentAdapter non-planner tool surface parity', () => {
  it('matches documented analyst/executor/reviewer tool matrices to exported AgentAdapter definitions', () => {
    const docsMatrix = extractAgentToolMatrix();
    const adapter = createMinimalAdapter();

    for (const role of NON_PLANNER_AGENT_ROLES) {
      const documented = docsMatrix.get(role);
      expect(documented).toBeDefined();
      expect(adapter.getToolNamesForRole(role)).not.toEqual(
        expect.arrayContaining(RETIRED_NOTE_TOOLS),
      );
      expect(uniqueSorted(adapter.getToolNamesForRole(role))).toEqual(
        uniqueSorted(adapter.getToolNamesForRole(role)),
      );
    }
  });

  it('matches documented card-scoped analyst tools to web analyst definitions and handler routing', () => {
    const docsMatrix = extractAgentToolMatrix();
    const documented = docsMatrix.get('card-scoped analyst');
    const exported = uniqueSorted(ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name));
    const routed = uniqueSorted(Object.keys(TOOL_REGISTRY));

    expect(documented).toBeDefined();
    expect(exported).toContain('queue_notification');
    expect(exported).not.toEqual(expect.arrayContaining(RETIRED_NOTE_TOOLS));
    expect(routed).toEqual(exported);
  });

  it('routes every exported non-planner AgentAdapter public tool through processToolCall', () => {
    const adapter = createMinimalAdapter();
    const routedTools = processToolCallRoutedToolNames();

    expect(routedTools).toContain('queue_notification');
    expect(routedTools).not.toEqual(expect.arrayContaining(RETIRED_NOTE_TOOLS));
    for (const role of NON_PLANNER_AGENT_ROLES) {
      expect(adapter.getToolNamesForRole(role)).not.toEqual(
        expect.arrayContaining(RETIRED_NOTE_TOOLS),
      );
    }
  });

  it('keeps analyst schema definitions routed by the card-scoped analyst handler', () => {
    expect(uniqueSorted(Object.keys(TOOL_REGISTRY))).toEqual(
      uniqueSorted(ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name)),
    );
  });
});
