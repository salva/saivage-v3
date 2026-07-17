import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import { buildTree } from '../stores/cards';
import { cardView } from './card-view-fixtures';

const GOAL_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEAF_ID = `${GOAL_ID}-bbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

describe('CardsTreeView', () => {
  it('renders children in committed parent children order from scrambled input', () => {
    const childIds = [
      'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'card-cccccccccccccccccccccccccccc',
    ];
    const root = cardView('project', { children: childIds });
    const low = cardView(childIds[0], { title: 'Zulu low', priority: 1, position: 30 });
    const high = cardView(childIds[1], { title: 'Alpha high', priority: 99, position: 20 });
    const mid = cardView(childIds[2], { title: 'Middle', priority: 50, position: 10 });
    const cards = [mid, root, high, low];
    const wrapper = mount(CardsTreeView, { props: { cards, tree: buildTree(cards), expandedIds: new Set(['project']), selectedCardId: null } });

    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project', 'Zulu low', 'Alpha high', 'Middle']);
  });

  it('reveals selected ancestors while selecting only the exact row and preserving its status ball', async () => {
    const root = cardView('project', { children: [GOAL_ID] });
    const goal = cardView(GOAL_ID, { type: 'goal', title: 'Goal', children: [LEAF_ID] });
    const leaf = cardView(LEAF_ID, { title: 'Selected leaf', status: 'blocked' });
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
    const root = cardView('project', { children: [GOAL_ID] });
    const leaf = cardView(GOAL_ID, { title: 'Leaf' });
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
