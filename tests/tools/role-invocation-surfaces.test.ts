import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import { ANALYST_CONTROL_TOOLS } from '../../src/tools/analyst-tool-registry.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { buildRoleSurface } from '../../src/tools/role-invocation-surfaces.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'role-surface-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}

function names(surface: ReturnType<typeof buildRoleSurface>): string[] {
  return [...surface.tools.keys()].sort();
}

describe('role invocation surfaces', () => {
  it('pins the planner provider-derived tool set', () => {
    const projectRoot = setupRoot();
    const store = new CardStore(projectRoot);
    const surface = buildRoleSurface('planner', {
      projectRoot,
      cardId: 'project',
      sessionId: 'planner:project',
      store,
      children: { get: () => null },
    });

    expect(names(surface)).toEqual([
      'activate_card', 'cancel_card', 'create_card', 'diff_card', 'edit', 'edit_card', 'get_card', 'get_card_history_entry', 'get_tree', 'glob', 'grep', 'list_card_history', 'list_cards', 'queue_notification', 'read', 'reorder_child', 'webfetch', 'websearch', 'write',
    ].sort());
  });

  it('pins the reviewer provider-derived tool set', () => {
    const projectRoot = setupRoot();
    const surface = buildRoleSurface('reviewer', {
      projectRoot,
      cardId: 'project',
      sessionId: 'reviewer:project:assessment-1',
      mcpManagerProvider: () => undefined,
    });

    expect(names(surface)).toEqual([
      'diff_card', 'edit', 'get_card_history_entry', 'glob', 'grep', 'list_card_history', 'mcp_tool_call', 'read', 'skill', 'webfetch', 'websearch', 'write',
    ].sort());
  });

  it('pins the executor provider-derived tool set', () => {
    const projectRoot = setupRoot();
    const processRunner = createTestProcessRunner(projectRoot);
    const surface = buildRoleSurface('executor', {
      projectRoot,
      cardId: 'card-1',
      sessionId: 'activation-1',
      ownerId: 'activation-1',
      processRunner,
      processScope: processRunner.createDirectScope(processRunner.runtimeRootScope, 'test-executor', 'runtime_card'),
      mcpManagerProvider: () => undefined,
    });

    expect(names(surface)).toEqual([
      'apply_patch', 'diff_card', 'edit', 'get_card_history_entry', 'glob', 'grep', 'kill_process', 'list_card_history', 'mcp_tool_call', 'read', 'run_command', 'skill', 'wait_process', 'webfetch', 'websearch', 'write',
    ].sort());
  });

  it('pins the analyst provider-derived tool set', () => {
    const projectRoot = setupRoot();
    const store = new CardStore(projectRoot);
    const processRunner = createTestProcessRunner(projectRoot);
    const processScope = processRunner.createDirectScope(processRunner.analystRootScope, 'test-analyst', 'operator_session');
    const ctx: ToolContext = { projectRoot, processRunner, processScope, store, sessionId: 'analyst:test', actor: 'analyst', surface: 'web-chat', restartServerAvailable: false };
    const surface = buildRoleSurface('analyst', {
      projectRoot,
      toolContext: ctx,
      store,
      processRunner: ctx.processRunner,
      processScope,
      sessionId: ctx.sessionId,
      ownerId: ctx.sessionId,
      mcpManagerProvider: () => undefined,
    });

    expect(names(surface)).toEqual([
      ...ANALYST_CONTROL_TOOLS.filter((tool) => tool.name !== 'restart_server').map((tool) => tool.name),
      'apply_patch', 'diff_card', 'edit', 'get_card', 'get_card_history_entry', 'get_tree', 'glob', 'grep', 'kill_process', 'list_card_history', 'list_cards', 'mcp_tool_call', 'read', 'run_command', 'skill', 'wait_process', 'webfetch', 'websearch', 'write',
    ].sort());
  });
});
