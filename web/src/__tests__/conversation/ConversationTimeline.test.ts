import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline, type AgentTimeline, type TimelineRound } from '../../utils/agent-timeline';
import type { AgentConversationEntry } from '../../api/types';

function emptyTimeline(overrides: Partial<AgentTimeline> = {}): AgentTimeline {
  return { rounds: [], activeRoundId: null, ...overrides };
}

function round(id: string, kind: TimelineRound['kind']): TimelineRound {
  return {
    id, kind, position: 1, entries: [], texts: [], diagnostics: [], toolPairs: [], items: [],
  };
}

const ROUND_ID = 'r-assistant-0123456789abcdef0123456789abcdef';

function toolEntry(id: string, name: string, args: Record<string, unknown>, index: number): AgentConversationEntry {
  return {
    id, session_id: 'agent:analyst:global', role: 'assistant', kind: 'tool_call',
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
    round_id: ROUND_ID, message_index: index, block_index: 0, timestamp: `2026-07-21T00:00:0${index}Z`, tool: name, tool_call_id: id,
  } as AgentConversationEntry;
}

function resultEntry(id: string, callId: string, name: string, envelope: unknown, index: number): AgentConversationEntry {
  return {
    id, session_id: 'agent:analyst:global', role: 'tool', kind: 'tool_result', content: JSON.stringify(envelope),
    round_id: 'r-user-fedcba9876543210fedcba9876543210', message_index: index, block_index: 0,
    timestamp: `2026-07-21T00:00:0${index}Z`, tool: name, tool_call_id: callId,
  } as AgentConversationEntry;
}

function router() {
  return createRouter({ history: createWebHistory(), routes: [
    { path: '/files', name: 'files', component: { template: '<div />' } },
    { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } },
  ] });
}

describe('ConversationTimeline', () => {
  it('hides separator, agent name, and iteration number on consecutive same-author rounds', () => {
    const timeline = emptyTimeline({
      rounds: [
        round('r-assistant-1', 'assistant'),
        round('r-assistant-2', 'assistant'),
        round('r-user-1', 'user'),
      ],
    });

    const wrapper = mount(ConversationTimeline, { props: { timeline, expandedIds: new Set<string>() } });
    const cards = wrapper.findAll('[data-testid="round-card"]');

    expect(cards[0].classes()).not.toContain('continues-author');
    expect(cards[0].find('.round-head').exists()).toBe(true);

    expect(cards[1].classes()).toContain('continues-author');
    expect(cards[1].find('.round-head').exists()).toBe(false);

    expect(cards[2].classes()).not.toContain('continues-author');
    expect(cards[2].find('.round-head').exists()).toBe(true);
  });

  it('projects canonical tool rows to mounted pending, success, error, known, fallback, and Files-link chips', async () => {
    const entries: AgentConversationEntry[] = [
      toolEntry('call-read', 'read', { path: 'README.md' }, 0),
      toolEntry('call-mcp', 'mcp_reconcile', {}, 1),
      resultEntry('result-mcp', 'call-mcp', 'mcp_reconcile', { success: true }, 2),
      toolEntry('call-unknown', 'move_card', { id: 'old-card' }, 3),
      resultEntry('result-unknown', 'call-unknown', 'move_card', { success: false, error: 'boom' }, 4),
      toolEntry('call-fetch', 'webfetch', { url: 'https://example.com' }, 5),
      resultEntry('result-fetch', 'call-fetch', 'webfetch', { success: true, data: { stash_url: 'work:///tmp/stash/webfetch.txt' } }, 6),
    ];
    const timeline = entriesToTimeline(entries);
    expect(timeline.rounds[0].toolPairs.map((pair) => pair.status)).toEqual(['pending', 'ok', 'error', 'ok']);

    const r = router(); await r.push('/files'); await r.isReady();
    const wrapper = mount(ConversationTimeline, {
      props: { timeline, expandedIds: new Set(['call-mcp', 'call-unknown']) },
      global: { plugins: [r, createPinia()] },
    });
    const chips = wrapper.findAll('.tool-chip');
    expect(chips).toHaveLength(4);
    expect(chips[0].classes()).toContain('tool-chip-pending');
    expect(chips[0].text()).toContain('Read');
    expect(chips[0].text()).toContain('README.md');
    expect(chips[1].classes()).toContain('tool-chip-ok');
    expect(chips[1].text()).toContain('Reconcile MCP');
    expect(chips[1].text()).not.toContain('Generic tool');
    expect(chips[2].classes()).toContain('tool-chip-error');
    expect(chips[2].text()).toContain('Generic tool');
    expect(chips[2].findAll('button.raw-toggle')).toHaveLength(2);
    expect(chips[3].find('a.inline-part-file').text()).toBe('work:///tmp/stash/webfetch.txt');
    expect(chips[3].find('a.inline-part-file').attributes('href')).toContain('path=.saivage/work/tmp/stash/webfetch.txt');
    expect(wrapper.text()).not.toContain('stash_path');
  });
});
