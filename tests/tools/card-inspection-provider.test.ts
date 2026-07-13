import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';




import { buildInvocationSurface, invokeTool, surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { createCardInspectionProvider } from '../../src/tools/card-inspection-provider.js';
import { CARD_STATUS_VALUES, CARD_TYPE_VALUES } from '../../src/tools/tool-definition.js';

function setup(root: string): CardStore {
  initProjectTree(root);
  return new CardStore(root);
}

describe('CardInspectionProvider', () => {
  it('exposes list/get/tree schemas with enum filters', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-inspection-schema-'));
    const surface = buildInvocationSurface('analyst', [createCardInspectionProvider({ projectRoot: root, store: setup(root), agentRole: 'analyst' })]);
    expect([...surface.tools.keys()]).toEqual(['list_cards', 'get_card', 'get_tree']);
    const listDefinition = surfaceToolDefinitions(surface).find((tool) => tool.function.name === 'list_cards');
    const properties = listDefinition?.function.parameters.properties as Record<string, { anyOf?: Array<{ enum?: unknown; items?: { enum?: unknown } }>; enum?: unknown }>;
    expect(properties.status.anyOf?.[0]?.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(properties.status.anyOf?.[1]?.items?.enum).toEqual([...CARD_STATUS_VALUES]);
    expect(properties.type.anyOf?.[0]?.enum).toEqual([...CARD_TYPE_VALUES]);
    expect(properties.type.anyOf?.[1]?.items?.enum).toEqual([...CARD_TYPE_VALUES]);
    rmSync(root, { recursive: true, force: true });
    expect(properties.status.enum).toBeUndefined();
    expect(properties.type.enum).toBeUndefined();
  });

  it('preserves Analyst card read-model shape with numeric paths and record summaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-inspection-provider-'));
    try {
      const store = setup(root);
      const goal = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'goal', status: 'backlog', depth: 1, tags: ['g'], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const child = store.create({ type: 'code', parent: goal.id, title: 'Code', brief: 'code', status: 'backlog', depth: 2, tags: ['c'], priority: 2, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
      const open = store.openRecord(goal.id, 'status.md');
      store.editRecord(goal.id, 'status.md', open.version, 'status record');
      store.closeRecord(goal.id, 'status.md', open.version, 'planner', goal.version_seq);
      const surface = buildInvocationSurface('analyst', [createCardInspectionProvider({ projectRoot: root, store, agentRole: 'analyst' })]);

      const list = await invokeTool(surface, 'list_cards', {});
      const detail = await invokeTool(surface, 'get_card', { id: goal.id });
      const tree = await invokeTool(surface, 'get_tree', {});

      expect(list.success).toBe(true);
      if (list.success) expect(list.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'project', display_path: null }), expect.objectContaining({ id: goal.id, display_path: '1' })]));
      expect(detail.success).toBe(true);
      if (detail.success) {
        expect(detail.data).toEqual(expect.objectContaining({ id: goal.id, display_path: '1', effective_updated_at: expect.any(String), operator_summary: expect.any(Object) }));
        expect((detail.data as { children: Array<Record<string, unknown>> }).children).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, display_path: '1.1' })]));
        expect((detail.data as { records_by_filename: Record<string, { inline?: { content: string } }> }).records_by_filename['status.md'].inline?.content).toBe('status record');
      }
      expect(tree.success).toBe(true);
      if (tree.success) expect(tree.data).toEqual(expect.objectContaining({ id: 'project', display_path: null }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
