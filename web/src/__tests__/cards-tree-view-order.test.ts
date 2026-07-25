import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CardsTreeView from '../components/cards/CardsTreeView.vue';
import type { CardTreeNode, ChildrenLoadState } from '../stores/cards';
import { hierarchyView } from './card-view-fixtures';

const state = (status: ChildrenLoadState['status'], error: string | null = null): ChildrenLoadState => ({ status, error, refreshing: false, stale: false, staleReason: null, refreshError: null });
const loaded = (): ChildrenLoadState => state('loaded-nonempty');
const node = (id: string, path: string | null, children: readonly CardTreeNode[] = []): CardTreeNode => ({ card: hierarchyView(id, { title: id }), logicalPath: path, childNodes: children });

describe('CardsTreeView hierarchy slices', () => {
  it('renders immutable slice order and locally derived paths', () => {
    const tree = [node('project', null, [node('card-b', '1'), node('card-a', '2')])];
    const wrapper = mount(CardsTreeView, { props: { tree, expandedIds: new Set(['project']), forcedExpandedIds: new Set<string>(), selectedCardId: null, loadStateFor: loaded } });
    expect(wrapper.findAll('.node-title').map((entry) => entry.text())).toEqual(['project', 'card-b', 'card-a']);
    expect(wrapper.findAll('.node-path').map((entry) => entry.text())).toEqual(['1', '2']);
  });

  it('shows node-local loading and retry paths', async () => {
    const states: Record<string, ChildrenLoadState> = { project: loaded(), 'card-a': state('error', 'branch failed') };
    const tree = [node('project', null, [node('card-a', '1')])];
    const wrapper = mount(CardsTreeView, { props: { tree, expandedIds: new Set(['project']), forcedExpandedIds: new Set<string>(), selectedCardId: null, loadStateFor: (id) => states[id] ?? state('undiscovered') } });
    expect(wrapper.text()).toContain('branch failed');
    await wrapper.find('.node-retry').trigger('click');
    expect(wrapper.emitted('retry')).toEqual([['card-a']]);
  });

  it('presents undiscovered children as discovery and removes the affordance only for a confirmed leaf', () => {
    const states: Record<string, ChildrenLoadState> = { project: loaded(), 'card-a': state('undiscovered'), 'card-b': state('confirmed-leaf') };
    const tree = [node('project', null, [node('card-a', '1'), node('card-b', '2')])];
    const wrapper = mount(CardsTreeView, { props: { tree, expandedIds: new Set(['project']), forcedExpandedIds: new Set<string>(), selectedCardId: null, loadStateFor: (id) => states[id] ?? loaded() } });
    const rows = wrapper.findAll('.tree-node');
    expect(rows[1]!.find('button.node-toggle').attributes('aria-label')).toBe('Expand card-a');
    expect(rows[2]!.find('button.node-toggle').exists()).toBe(false);
  });

  it('selects only a represented exact row and route-forces represented ancestors', () => {
    const tree = [node('project', null, [node('card-a', '1', [node('card-a-b', '1.1')])])];
    const wrapper = mount(CardsTreeView, { props: { tree, expandedIds: new Set(['project', 'card-a']), forcedExpandedIds: new Set(['project', 'card-a']), selectedCardId: 'card-a-b', loadStateFor: loaded } });
    expect(wrapper.findAll('.tree-node.selected')).toHaveLength(1);
    expect(wrapper.find('.tree-node.selected').text()).toContain('card-a-b');
    expect(wrapper.findAll('.node-toggle').slice(0, 2).every((toggle) => toggle.attributes('disabled') !== undefined)).toBe(true);
  });
});
