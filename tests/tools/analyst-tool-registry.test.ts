import { describe, expect, it } from '@jest/globals';

import { createAnalystControlTools } from '../../src/tools/analyst-tool-registry.js';
import type { ToolDefinition } from '../../src/tools/invocation.js';
import { createAnalystControlProvider } from '../../src/tools/analyst-control-provider.js';

describe('registered Analyst card mutation catalog', () => {
  it('selects type only during creation and exposes no post-creation edit or update input', () => {
    const tools: readonly ToolDefinition<any>[] = createAnalystControlTools({} as never);
    expect(tools.map(({ name }) => name)).toEqual([
      'create_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server',
      'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions',
      'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card',
    ]);
    const registered = new Map(tools.map((tool) => [tool.name, tool]));
    const mutationNames = ['create_card', 'reorder_child', 'cancel_card', 'delete_card'] as const;

    expect(mutationNames.filter((name) => registered.has(name))).toEqual(mutationNames);
    expect(tools.map(({ name }) => name))
      .not.toEqual(expect.arrayContaining(['edit_card', 'update_card']));
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
    expect(tools.every(({ executor }) => typeof executor === 'function')).toBe(true);
    expect(registered.get('create_card')!.inputSchema.safeParse({
      type: 'code',
      parent: 'project',
      title: 'Create once',
      brief: 'Type is selected at creation.',
    }).success).toBe(true);

    const postCreationInputs = new Map<string, Record<string, unknown>>([
      ['reorder_child', { parentId: 'project', orderedChildIds: [] }],
      ['cancel_card', { cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      ['delete_card', { ids: ['card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }],
    ]);
    for (const [name, input] of postCreationInputs) {
      const schema = registered.get(name)!.inputSchema;
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, type: 'test' }).success).toBe(false);
    }
  });

  it('filters restart_server only when capability and destructive authorization both permit it', () => {
    const names = (restartServerAvailable: boolean, surface: 'web-chat' | 'rest') => createAnalystControlProvider({ restartServerAvailable, actor: 'analyst', surface } as never).tools.map(({ name }) => name);
    expect(names(false, 'web-chat')).not.toContain('restart_server');
    expect(names(true, 'rest')).not.toContain('restart_server');
    expect(names(true, 'web-chat')).toContain('restart_server');
  });
});
