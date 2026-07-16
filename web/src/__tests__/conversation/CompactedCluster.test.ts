import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CompactedCluster from '../../components/conversation/CompactedCluster.vue';
import type { AgentConversationEntry } from '../../api/types';

function entry(index: number, overrides: Partial<AgentConversationEntry> = {}): AgentConversationEntry {
  return {
    id: `entry-${index}`,
    session_id: 'planner:11111111-1111-4111-8111-111111111111',
    role: index % 2 === 0 ? 'assistant' : 'user',
    kind: 'text',
    content: `Compacted historical message ${index}`,
    round_id: 'r-compacted-00000000000000000000000000000001',
    message_index: index,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentConversationEntry;
}

describe('CompactedCluster', () => {
  it('shows a bounded sample and reports hidden compacted entries', () => {
    const wrapper = mount(CompactedCluster, { props: { entries: Array.from({ length: 8 }, (_, index) => entry(index)) } });

    expect(wrapper.findAll('.compacted-item')).toHaveLength(5);
    expect(wrapper.text()).toContain('8 entries');
    expect(wrapper.text()).toContain('4 assistant');
    expect(wrapper.text()).toContain('4 user');
    expect(wrapper.text()).toContain('3 more compacted entries hidden');
  });

  it('truncates long compacted previews', () => {
    const wrapper = mount(CompactedCluster, { props: { entries: [entry(1, { content: 'x'.repeat(140) })] } });

    const preview = wrapper.find('.compacted-preview').text();
    expect(preview).toHaveLength(99);
    expect(preview.endsWith('...')).toBe(true);
  });
});
