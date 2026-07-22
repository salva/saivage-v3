import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyAgentToolDocs, verifyConfigDocs } from '../../scripts/verify-doc-routes.js';

const AGENTS = 'src/agents/default-workflow-config.ts';
const CONFIG = 'src/schemas/saivage-config.ts';
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function rewrite(root, path, transform) {
  const fullPath = join(root, path);
  writeFileSync(fullPath, transform(readFileSync(fullPath, 'utf8')));
}

function replaceChecked(root, path, target, replacement) {
  rewrite(root, path, (source) => {
    expect(source).toContain(target);
    return source.replace(target, replacement);
  });
}

function failureTypes(result) { return result.failures.map((failure) => failure.type); }

describe('source-derived named-agent tool inventory', () => {
  it('discovers the exact default named-agent inventories', () => {
    const result = verifyAgentToolDocs({ projectRoot: process.cwd() });
    expect(result.ok).toBe(true);
    expect(Object.fromEntries(result.expected)).toEqual({
      planner: ['activate_card', 'cancel_card', 'create_card', 'diff_card', 'edit', 'edit_card', 'get_card', 'get_card_history_entry', 'get_tree', 'glob', 'grep', 'list_card_history', 'list_cards', 'queue_notification', 'read', 'reorder_child', 'webfetch', 'websearch', 'write'],
      reviewer: ['diff_card', 'edit', 'get_card_history_entry', 'glob', 'grep', 'list_card_history', 'read', 'skill', 'webfetch', 'websearch', 'write'],
      executor: ['apply_patch', 'diff_card', 'edit', 'get_card_history_entry', 'glob', 'grep', 'kill_process', 'list_card_history', 'mcp_tool_call', 'read', 'run_command', 'skill', 'wait_process', 'webfetch', 'websearch', 'write'],
      analyst: ['apply_patch', 'cancel_card', 'create_card', 'delete_card', 'diff_card', 'edit', 'get_card', 'get_card_history_entry', 'get_status', 'get_tree', 'glob', 'grep', 'kill_process', 'list_agent_sessions', 'list_card_history', 'list_cards', 'list_processes_tool', 'mcp_reconcile', 'mcp_tool_call', 'navigate_back', 'navigate_workspace', 'pause_runtime', 'queue_notification', 'read', 'read_agent_session', 'read_control_actions', 'read_runtime_errors', 'read_runtime_events', 'reconfigure', 'reorder_child', 'restart_server', 'resume_runtime', 'run_command', 'show_config', 'skill', 'start_project', 'stop_project', 'wait_process', 'webfetch', 'websearch', 'write'],
    });
  });

  it('derives literal catalog changes and rejects invalid catalog syntax', () => {
    withFixture([AGENTS, DOC], (root) => {
      replaceChecked(root, AGENTS, "'activate_card'", "'fixture_tool'");
      expect(verifyAgentToolDocs({ projectRoot: root }).expected.get('planner')).toContain('fixture_tool');
    });
    withFixture([AGENTS, DOC], (root) => {
      replaceChecked(root, AGENTS, "['create_card', 'edit_card'", "['create_card', 'create_card'");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('contains duplicates');
    });
    withFixture([AGENTS, DOC], (root) => {
      replaceChecked(root, AGENTS, "Object.freeze(['create_card', 'edit_card'", "Object.freeze([computedTool, 'edit_card'");
      expect(() => verifyAgentToolDocs({ projectRoot: root })).toThrow('contains a non-string entry');
    });
  });

  it('rejects duplicate, unexpected, and malformed documentation rows', () => {
    withFixture([AGENTS, DOC], (root) => {
      const row = readFileSync(join(root, DOC), 'utf8').match(/^\| `planner` .*$/m)[0];
      replaceChecked(root, DOC, '<!-- saivage:agent-tools:end -->', `${row}\n<!-- saivage:agent-tools:end -->`);
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('duplicate-agent');
    });
    withFixture([AGENTS, DOC], (root) => {
      replaceChecked(root, DOC, '<!-- saivage:agent-tools:end -->', "| `supervisor` | `` | `src/agents/default-workflow-config.ts:1` |\n<!-- saivage:agent-tools:end -->");
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('unexpected-agent');
    });
    withFixture([AGENTS, DOC], (root) => {
      replaceChecked(root, DOC, '| `planner` | `activate_card', '| `planner` | activate_card');
      expect(failureTypes(verifyAgentToolDocs({ projectRoot: root }))).toContain('malformed-agent-tool-row');
    });
  });
});

describe('source-derived Config schema inventory', () => {
  it('discovers every current object occurrence', () => {
    const result = verifyConfigDocs({ projectRoot: process.cwd() });
    expect(result.ok).toBe(true);
    expect([...result.expected.keys()]).toEqual([
      'top-level', 'agents.entry', 'models', 'models.routes.entry', 'models.profiles.entry', 'providers.entry',
      'providers.entry.capabilities', 'providers.entry.capabilities.responsesReasoning',
      'providers.entry.modelCapabilities.entry', 'providers.entry.modelCapabilities.entry.responsesReasoning',
      'providers.entry.accounts.entry', 'providers.entry.accounts.entry.capabilities',
      'providers.entry.accounts.entry.capabilities.responsesReasoning', 'server', 'compaction', 'compaction.summarizer_candidate',
      'card_types.entry', 'card_types.entry.records.entry', 'card_types.entry.workflow', 'card_types.entry.workflow.entries',
      'card_types.entry.workflow.entries.BACKLOG', 'card_types.entry.workflow.entries.CHANGED', 'card_types.entry.workflow.entries.BLOCKED', 'card_types.entry.workflow.entries.STOPPED',
      'card_types.entry.workflow.nodes.entry', 'card_types.entry.workflow.nodes.entry.descendant_context', 'card_types.entry.workflow.nodes.entry.edges.entry',
      'card_types.entry.workflow.nodes.entry.edges.entry.target.variant1', 'card_types.entry.workflow.nodes.entry.edges.entry.target.variant2',
      'card_types.entry.workflow.nodes.entry.edges.entry.target.variant2.promote.variant2', 'mcpServers.entry.variant1', 'mcpServers.entry.variant2',
    ]);
  });

  it('turns newly reachable objects into missing-row failures and fails closed for unsupported syntax', () => {
    withFixture([CONFIG, DOC], (root) => {
      replaceChecked(root, CONFIG, 'export const saivageConfigSchema = z.object({', 'const futureSchema = z.object({ value: z.string() });\nexport const saivageConfigSchema = z.object({\n  futureNamed: futureSchema,');
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('missing-config-section');
    });
    withFixture([CONFIG, DOC], (root) => {
      replaceChecked(root, CONFIG, 'export const saivageConfigSchema = z.object({', 'export const saivageConfigSchema = z.object({\n  future: z.lazy(() => z.string()),');
      expect(() => verifyConfigDocs({ projectRoot: root })).toThrow('Unsupported reachable z.lazy');
    });
    withFixture([CONFIG, DOC], (root) => {
      replaceChecked(root, CONFIG, 'export const saivageConfigSchema = z.object({', 'export const saivageConfigSchema = z.object({\n  future: unresolvedSchema,');
      expect(() => verifyConfigDocs({ projectRoot: root })).toThrow('Unable to resolve unresolvedSchema');
    });
  });

  it('rejects missing, unexpected, duplicate, and malformed documentation rows', () => {
    withFixture([CONFIG, DOC], (root) => {
      rewrite(root, DOC, (source) => source.replace(/^\| `models` .*\n/m, ''));
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('missing-config-section');
    });
    withFixture([CONFIG, DOC], (root) => {
      replaceChecked(root, DOC, '<!-- saivage:config-schema:end -->', "| `supervisor` | `` | `src/schemas/saivage-config.ts:1` |\n<!-- saivage:config-schema:end -->");
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('unexpected-config-section');
    });
    withFixture([CONFIG, DOC], (root) => {
      const row = readFileSync(join(root, DOC), 'utf8').match(/^\| `models` .*$/m)[0];
      replaceChecked(root, DOC, '<!-- saivage:config-schema:end -->', `${row}\n<!-- saivage:config-schema:end -->`);
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('duplicate-config-section');
    });
    withFixture([CONFIG, DOC], (root) => {
      replaceChecked(root, DOC, '| `models` | `equivalents', '| `models` | equivalents');
      expect(failureTypes(verifyConfigDocs({ projectRoot: root }))).toContain('malformed-config-row');
    });
  });
});
