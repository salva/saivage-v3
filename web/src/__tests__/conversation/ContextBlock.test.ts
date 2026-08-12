import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ContextBlock from '../../components/conversation/ContextBlock.vue';
import type { AgentConversationEntry } from '../../api/types';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } }, { path: '/debug', name: 'debug', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }] }); }

function entry(overrides: Partial<AgentConversationEntry>): AgentConversationEntry {
  return {
    id: 'entry-1',
    session_id: 'agent:planner:card-a',
    role: 'system',
    kind: 'text',
    content: 'Plan and coordinate card 11111111-1111-4111-8111-111111111111',
    round_id: 'r-pre-00000000000000000000000000000001',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentConversationEntry;
}

describe('ContextBlock', () => {
  it('renders system text as an ordinary durable block', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ContextBlock, { props: { entry: entry({}) }, global: { plugins: [createPinia(), r] } });

    expect(wrapper.find('details.context-block').exists()).toBe(false);
    expect(wrapper.find('article.context-block').exists()).toBe(true);
    expect(wrapper.text()).toContain('Plan and coordinate');
  });

  it('renders non-system prompt entries expanded as normal blocks', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ContextBlock, { props: { entry: entry({ role: 'assistant', kind: 'text', content: 'Visible assistant text' }) }, global: { plugins: [createPinia(), r] } });

    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.find('article.context-block').exists()).toBe(true);
    expect(wrapper.text()).toContain('Visible assistant text');
    expect(wrapper.find('.context-role').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Assistant');
  });
});
