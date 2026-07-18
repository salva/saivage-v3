import { describe, expect, it } from '@jest/globals';

import { ANALYST_CONTROL_TOOLS } from '../../src/tools/analyst-tool-registry.js';

describe('registered Analyst card mutation catalog', () => {
  it('selects type only during creation and exposes no post-creation edit or update input', () => {
    const registered = new Map(ANALYST_CONTROL_TOOLS.map((tool) => [tool.name, tool]));
    const mutationNames = ['create_card', 'reorder_child', 'cancel_card', 'delete_card'] as const;

    expect(mutationNames.filter((name) => registered.has(name))).toEqual(mutationNames);
    expect(ANALYST_CONTROL_TOOLS.map(({ name }) => name))
      .not.toEqual(expect.arrayContaining(['edit_card', 'update_card']));
    expect(registered.get('create_card')!.input.safeParse({
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
      const schema = registered.get(name)!.input;
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, type: 'test' }).success).toBe(false);
    }
  });
});
