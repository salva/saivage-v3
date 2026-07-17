import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CardRecord } from '../api/types';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import { buildTree } from '../stores/cards';

function card(overrides: Partial<CardRecord>): CardRecord {
  const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle'];
  return { id: 'project', type: 'code', parent: null, depth: 0, position: 0, children: [], title: 'Card', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], ...overrides, logical_path: overrides.logical_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } };
}

describe('CardsTreeView', () => {
  it('renders children in input/backend order without priority-title resorting', () => {
    const root = card({ id: 'project', type: 'project', title: 'Project' });
    const low = card({ id: '11111111-1111-4111-8111-111111111111', parent: 'project', title: 'Zulu low', priority: 1 });
    const high = card({ id: '22222222-2222-4222-8222-222222222222', parent: 'project', title: 'Alpha high', priority: 99 });
    const mid = card({ id: '33333333-3333-4333-8333-333333333333', parent: 'project', title: 'Middle', priority: 50 });
    const wrapper = mount(CardsTreeView, { props: { cards: [root, low, high, mid], tree: buildTree([root, low, high, mid]), expandedIds: new Set(['project']), selectedCardId: null } });

    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project', 'Zulu low', 'Alpha high', 'Middle']);
  });

  it('reveals selected ancestors while selecting only the exact row and preserving its status ball', async () => {
    const root = card({ id: 'project', type: 'project', title: 'Project' });
    const goal = card({ id: '11111111-1111-4111-8111-111111111111', parent: 'project', type: 'goal', title: 'Goal' });
    const leaf = card({ id: '22222222-2222-4222-8222-222222222222', parent: goal.id, title: 'Selected leaf', status: 'blocked' });
    const wrapper = mount(CardsTreeView, {
      props: { cards: [root, goal, leaf], tree: buildTree([root, goal, leaf]), expandedIds: new Set<string>(), selectedCardId: leaf.id },
    });

    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project', 'Goal', 'Selected leaf']);
    expect(wrapper.findAll('.tree-node.selected')).toHaveLength(1);
    const selected = wrapper.find('.tree-node.selected');
    expect(selected.attributes('aria-current')).toBe('true');
    expect(selected.text()).toContain('Selected leaf');
    expect(selected.find('.state-ball').classes()).toContain('card-status-blocked');
    expect(wrapper.findAll('.tree-node').filter((row) => !row.classes().includes('selected')).every((row) => row.attributes('aria-current') === undefined)).toBe(true);

    const forcedToggles = wrapper.findAll('button.node-toggle');
    expect(forcedToggles).toHaveLength(2);
    expect(forcedToggles.every((toggle) => toggle.attributes('disabled') !== undefined)).toBe(true);
    expect(forcedToggles.map((toggle) => toggle.attributes('aria-label'))).toEqual([
      'Project: Expanded to show selected card',
      'Goal: Expanded to show selected card',
    ]);
    await forcedToggles[0].trigger('click');
    expect(wrapper.emitted('toggle')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('uses explicit expansion for an actionable ancestor and resumes collapse when reveal ends', async () => {
    const root = card({ id: 'project', type: 'project', title: 'Project' });
    const leaf = card({ id: '11111111-1111-4111-8111-111111111111', parent: 'project', title: 'Leaf' });
    const wrapper = mount(CardsTreeView, {
      props: { cards: [root, leaf], tree: buildTree([root, leaf]), expandedIds: new Set(['project']), selectedCardId: leaf.id },
    });

    const toggle = wrapper.find('button.node-toggle');
    expect(toggle.attributes('disabled')).toBeUndefined();
    expect(toggle.attributes('aria-label')).toBe('Collapse Project');
    await toggle.trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['project']]);

    await wrapper.setProps({ expandedIds: new Set<string>() });
    expect(wrapper.find('button.node-toggle').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.node-title').text()).toBe('Project');
    expect(wrapper.findAll('.node-title').map((node) => node.text())).toContain('Leaf');

    await wrapper.setProps({ selectedCardId: null });
    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project']);
  });

  it('uses unconditional empty-list copy', () => {
    const wrapper = mount(CardsTreeView, { props: { cards: [], tree: [], expandedIds: new Set<string>(), selectedCardId: null } });
    expect(wrapper.text()).toBe('No cards available.');
  });
});
