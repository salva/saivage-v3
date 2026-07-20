import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyAgentToolDocs, verifyConfigDocs } from '../../scripts/verify-doc-routes.js';

const TOOL_SOURCES = [
  'src/tools/role-invocation-surfaces.ts',
  'src/tools/planner-control-provider.ts',
  'src/tools/analyst-control-provider.ts',
  'src/tools/analyst-tool-registry.ts',
  'src/tools/card-inspection-provider.ts',
  'src/tools/card-history-provider.ts',
  'src/tools/workspace-provider.ts',
  'src/tools/process-provider.ts',
  'src/tools/web-tools.ts',
  'src/tools/skill-provider.ts',
  'src/tools/mcp-provider.ts',
  'src/runtime/actors/agent-node-execution.ts',
  'src/contracts/result-envelope.ts',
];
const DOC = 'docs/architecture/system-architecture.md';

function withFixture(paths, testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-doc-inventory-'));
  try {
    for (const path of paths) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(process.cwd(), path), 'utf8'));
    }
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rewrite(root, path, transform) {
  const fullPath = join(root, path);
  writeFileSync(fullPath, transform(readFileSync(fullPath, 'utf8')));
}

function replaceChecked(root, path, target, replacement) {
  rewrite(root, path, (source) => {
    expect(source).toContain(target);
    const changed = source.replace(target, replacement);
    expect(changed).not.toBe(source);
    return changed;
  });
}

function replaceAllChecked(root, path, pattern, replacement, expectedCount) {
  rewrite(root, path, (source) => {
    const matches = source.match(pattern) ?? [];
    expect(matches).toHaveLength(expectedCount);
    const changed = source.replace(pattern, replacement);
    expect(changed).not.toBe(source);
    return changed;
  });
}

function removeRoleCase(root, role, nextRole) {
  rewrite(root, 'src/tools/role-invocation-surfaces.ts', (source) => {
    const startMarker = `    case '${role}':`;
    const endMarker = `    case '${nextRole}':`;
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(0, start) + source.slice(end);
  });
}

function failureTypes(result) {
  return result.failures.map((failure) => failure.type);
}

describe('source-derived Agent tool inventory', () => {
  it('discovers every current role surface, provider branch, control input, and autonomous terminal', () => {
    const result = verifyAgentToolDocs({ projectRoot: process.cwd() });
    expect(result.ok).toBe(true);
    expect(Object.fromEntries(result.expected)).toEqual({
      planner: ['activate_card', 'cancel_card', 'create_card', 'diff_card', 'edit', 'edit_card', 'emit_result', 'get_card', 'get_card_history_entry', 'get_tree', 'glob', 'grep', 'list_card_history', 'list_cards', 'queue_notification', 'read', 'reorder_child', 'webfetch', 'websearch', 'write'],
      reviewer: ['diff_card', 'edit', 'emit_result', 'get_card_history_entry', 'glob', 'grep', 'list_card_history', 'mcp_tool_call', 'read', 'skill', 'webfetch', 'websearch', 'write'],
      executor: ['apply_patch', 'diff_card', 'edit', 'emit_result', 'get_card_history_entry', 'glob', 'grep', 'kill_process', 'list_card_history', 'mcp_tool_call', 'read', 'run_command', 'skill', 'wait_process', 'webfetch', 'websearch', 'write'],
      analyst: ['apply_patch', 'cancel_card', 'create_card', 'delete_card', 'diff_card', 'edit', 'get_card', 'get_card_history_entry', 'get_status', 'get_tree', 'glob', 'grep', 'kill_process', 'list_agent_sessions', 'list_card_history', 'list_cards', 'list_processes_tool', 'mcp_reconcile', 'mcp_tool_call', 'navigate_back', 'navigate_workspace', 'pause_runtime', 'queue_notification', 'read', 'read_agent_session', 'read_control_actions', 'read_runtime_errors', 'read_runtime_events', 'reconfigure', 'reorder_child', 'restart_server', 'resume_runtime', 'run_command', 'show_config', 'skill', 'start_project', 'stop_project', 'wait_process', 'webfetch', 'websearch', 'write'],
    });
    expect(result.expected.get('analyst')).toContain('restart_server');
    expect(result.expected.get('analyst')).not.toContain('emit_result');
  });

  it('derives literal switch composition and autonomous-only terminal injection', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', "        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),\n      ]);\n    case 'reviewer':", "      ]);\n    case 'reviewer':");
      expect(verifyAgentToolDocs({ projectRoot: root }).expected.get('planner')).not.toContain('websearch');

      replaceChecked(root, 'src/tools/skill-provider.ts', "name: 'skill'", "name: 'fixture_skill'");
      expect(verifyAgentToolDocs({ projectRoot: root }).expected.get('executor')).toContain('fixture_skill');

      replaceChecked(root, 'src/tools/analyst-tool-registry.ts', "  'create_card',", "  'fixture_control',");
      expect(verifyAgentToolDocs({ projectRoot: root }).expected.get('analyst')).toContain('fixture_control');

      replaceChecked(root, 'src/contracts/result-envelope.ts', "'emit_result'", "'fixture_terminal'");
      const terminalChanged = verifyAgentToolDocs({ projectRoot: root }).expected;
      expect(terminalChanged.get('planner')).toContain('fixture_terminal');
      expect(terminalChanged.get('executor')).toContain('fixture_terminal');
      expect(terminalChanged.get('reviewer')).toContain('fixture_terminal');
      expect(terminalChanged.get('analyst')).not.toContain('fixture_terminal');
    });
  });

  it('rejects duplicate, unexpected, and malformed rows through real Markdown parsing', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      const row = readFileSync(join(root, DOC), 'utf8').match(/^\| `planner` .*$/m)[0];
      replaceChecked(root, DOC, '<!-- saivage:agent-tools:end -->', `${row}\n<!-- saivage:agent-tools:end -->`);
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('duplicate-agent-role');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, DOC, '<!-- saivage:agent-tools:end -->', "| `supervisor` | `` | `src/tools/role-invocation-surfaces.ts:40` |\n<!-- saivage:agent-tools:end -->");
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('unexpected-agent-role');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, DOC, '| `planner` | `activate_card', '| `planner` | activate_card');
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('malformed-agent-tool-row');
    });
  });

  it('fails closed for missing, duplicate, unsupported, and all default cases', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      removeRoleCase(root, 'reviewer', 'executor');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Missing provider-composition case for reviewer');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', "    case 'executor':", "    case 'reviewer':");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Duplicate provider-composition case for reviewer');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', "    case 'executor':", "    case 'supervisor':");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Unsupported agent role case supervisor');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', "    }\n  }\n}", "    }\n    default:\n      return buildInvocationSurface(context.role, []);\n  }\n}");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Default provider-composition paths are unsupported');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', "    }\n  }\n}", "    }\n    default:\n      return null;\n  }\n}");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Default provider-composition paths are unsupported');
    });
  });

  it('fails closed for nonliteral arrays and every unsupported provider-array entry form', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      rewrite(root, 'src/tools/role-invocation-surfaces.ts', (source) => {
        const startMarker = "    case 'planner':\n      return buildInvocationSurface(context.role, [";
        const start = source.indexOf(startMarker);
        const end = source.indexOf('      ]);', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        return `${source.slice(0, start)}    case 'planner':\n      return buildInvocationSurface(context.role, plannerProviders);${source.slice(end + '      ]);'.length)}`;
      });
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('planner provider composition must use an array literal');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '        createPlannerControlProvider({', '        ...createPlannerControlProvider({');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('planner provider array contains a spread entry');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '        createCardInspectionProvider({ store: context.store }),', '        context.store,');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('planner provider array contains an unsupported entry');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '        createCardInspectionProvider({ store: context.store }),', '        true ? createCardInspectionProvider({ store: context.store }) : createCardInspectionProvider({ store: context.store }),');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('planner provider array contains an unsupported entry');
    });
  });

  it('fails closed for unknown, computed, and otherwise indirect constructor or composition calls', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '        createPlannerControlProvider({', '        createUnknownProvider({');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Unknown provider constructor createUnknownProvider for planner');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '        createCardInspectionProvider({ store: context.store }),', "        providers['createCardInspectionProvider']({ store: context.store }),");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('planner provider array contains an unsupported entry');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/role-invocation-surfaces.ts', '      return buildInvocationSurface(context.role, [', '      return context.buildInvocationSurface(context.role, [');
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Unsupported buildInvocationSurface return for planner');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      rewrite(root, 'src/tools/role-invocation-surfaces.ts', (source) => {
        const start = source.indexOf("    case 'planner':\n      return buildInvocationSurface(context.role, [");
        const end = source.indexOf('      ]);', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const changedStart = source.slice(0, start).concat(source.slice(start, end).replace('      return buildInvocationSurface', '      const surface = buildInvocationSurface'));
        return `${changedStart}      ]);\n      return surface;${source.slice(end + '      ]);'.length)}`;
      });
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Unsupported buildInvocationSurface return for planner');
    });
  });

  it('requires complete and non-stale provider source navigation', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceAllChecked(root, 'src/tools/role-invocation-surfaces.ts', /createWebProvider/g, 'createFixtureProvider', 5);
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Missing provider source navigation for createFixtureProvider');
    });
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceAllChecked(root, 'src/tools/role-invocation-surfaces.ts', /^\s*createSkillProvider\([^\n]+\),\n/gm, '', 3);
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Unreferenced provider source navigation for createSkillProvider');
    });
  });

  it('rejects duplicate tool names produced by composed providers', () => {
    withFixture([...TOOL_SOURCES, DOC], (root) => {
      replaceChecked(root, 'src/tools/web-tools.ts', "name: 'websearch'", "name: 'webfetch'");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('Duplicate resulting tool name for planner');
    });
  });
});

describe('source-derived Config schema inventory', () => {
  it('discovers all current object occurrences and repeated capability/reasoning shapes', () => {
    const result = verifyConfigDocs({ projectRoot: process.cwd() });
    expect(result.ok).toBe(true);
    expect([...result.expected.keys()]).toEqual([
      'top-level', 'models', 'models.profiles.entry', 'providers.entry',
      'providers.entry.capabilities', 'providers.entry.capabilities.responsesReasoning',
      'providers.entry.modelCapabilities.entry', 'providers.entry.modelCapabilities.entry.responsesReasoning',
      'providers.entry.accounts.entry', 'providers.entry.accounts.entry.capabilities',
      'providers.entry.accounts.entry.capabilities.responsesReasoning', 'server', 'runtime',
      'runtime.process_timeouts', 'security', 'compaction', 'compaction.summarizer_candidate',
      'card_processes', 'card_processes.planning', 'card_processes.planning.entries',
      'card_processes.planning.entries.BACKLOG', 'card_processes.planning.entries.CHANGED', 'card_processes.planning.entries.BLOCKED', 'card_processes.planning.entries.STOPPED',
      'card_processes.planning.nodes.entry', 'card_processes.planning.nodes.entry.records.item', 'card_processes.planning.nodes.entry.edges.entry',
      'card_processes.planning.nodes.entry.edges.entry.target.variant1', 'card_processes.planning.nodes.entry.edges.entry.target.variant2',
      'card_processes.terminal', 'card_processes.terminal.entries',
      'card_processes.terminal.entries.BACKLOG', 'card_processes.terminal.entries.CHANGED', 'card_processes.terminal.entries.BLOCKED', 'card_processes.terminal.entries.STOPPED',
      'card_processes.terminal.nodes.entry', 'card_processes.terminal.nodes.entry.records.item', 'card_processes.terminal.nodes.entry.edges.entry',
      'card_processes.terminal.nodes.entry.edges.entry.target.variant1', 'card_processes.terminal.nodes.entry.edges.entry.target.variant2', 'mcpServers.entry',
    ]);
    for (const path of ['providers.entry.capabilities', 'providers.entry.modelCapabilities.entry', 'providers.entry.accounts.entry.capabilities']) {
      expect(result.expected.get(path)).toEqual(['contextWindowTokens', 'exclusiveToolChoiceSupport', 'maxOutputTokens', 'quirks', 'responsesReasoning', 'streaming', 'toolsMode', 'transportProtocol']);
      expect(result.expected.get(`${path}.responsesReasoning`)).toEqual(['effort']);
    }
  });

  it('turns newly reachable named and inline objects into missing-row failures', () => {
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, 'src/agents/config-schema.ts', (source) => source.replace("export const saivageConfigSchema = z.object({", "const futureSchema = z.object({ value: z.string() });\nexport const saivageConfigSchema = z.object({\n  futureNamed: futureSchema,"));
      expect(verifyConfigDocs({ projectRoot: root }).failures).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'missing-config-section', section: 'futureNamed' })]));
    });
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, 'src/agents/config-schema.ts', (source) => source.replace("export const saivageConfigSchema = z.object({", "export const saivageConfigSchema = z.object({\n  futureInline: z.object({ value: z.string() }),"));
      expect(verifyConfigDocs({ projectRoot: root }).failures).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'missing-config-section', section: 'futureInline' })]));
    });
  });

  it('fails closed for unsupported and unresolved reachable schema syntax', () => {
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, 'src/agents/config-schema.ts', (source) => source.replace("export const saivageConfigSchema = z.object({", "export const saivageConfigSchema = z.object({\n  future: z.lazy(() => z.object({ value: z.string() })),"));
      expect(() => verifyConfigDocs({ projectRoot: root })).toThrow('Unsupported reachable z.lazy');
    });
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, 'src/agents/config-schema.ts', (source) => source.replace("export const saivageConfigSchema = z.object({", "export const saivageConfigSchema = z.object({\n  future: unresolvedSchema,"));
      expect(() => verifyConfigDocs({ projectRoot: root })).toThrow('Unable to resolve unresolvedSchema');
    });
  });

  it('rejects missing, unexpected, duplicate, and malformed rows through real Markdown parsing', () => {
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, DOC, (source) => source.replace(/^\| `models` .*\n/m, ''));
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('missing-config-section');
    });
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, DOC, (source) => source.replace('<!-- saivage:config-schema:end -->', "| `supervisor` | `` | `src/agents/config-schema.ts:191` |\n<!-- saivage:config-schema:end -->"));
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('unexpected-config-section');
    });
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      const row = readFileSync(join(root, DOC), 'utf8').match(/^\| `models` .*$/m)[0];
      rewrite(root, DOC, (source) => source.replace('<!-- saivage:config-schema:end -->', `${row}\n<!-- saivage:config-schema:end -->`));
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('duplicate-config-section');
    });
    withFixture(['src/agents/config-schema.ts', DOC], (root) => {
      rewrite(root, DOC, (source) => source.replace('| `models` | `default', '| `models` | default'));
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('malformed-config-row');
    });
  });
});
