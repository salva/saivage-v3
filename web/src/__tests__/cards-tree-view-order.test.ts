import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CardRecord } from '../api/types';
import CardsTreeView from '../components/cards/CardsTreeView.vue';

function card(overrides: Partial<CardRecord>): CardRecord {
  return { id: 'card', type: 'code', parent: null, depth: 0, position: 0, title: 'Card', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, ...overrides, display_path: overrides.display_path ?? null, lifecycle: overrides.lifecycle ?? { status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle'] };
}

describe('CardsTreeView order', () => {
  it('renders children in input/backend order without priority-title resorting', () => {
    const root = card({ id: 'project', type: 'project', title: 'Project' });
    const low = card({ id: 'low', parent: 'project', title: 'Zulu low', priority: 1 });
    const high = card({ id: 'high', parent: 'project', title: 'Alpha high', priority: 99 });
    const mid = card({ id: 'mid', parent: 'project', title: 'Middle', priority: 50 });
    const wrapper = mount(CardsTreeView, { props: { cards: [root, low, high, mid], tree: [root], expandedIds: new Set(['project']) } });

    expect(wrapper.findAll('.node-title').map((node) => node.text())).toEqual(['Project', 'Zulu low', 'Alpha high', 'Middle']);
  });
});
