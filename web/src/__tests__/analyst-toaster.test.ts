import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AnalystToaster from '../components/chat/AnalystToaster.vue';
import { useAnalystChat } from '../stores/analystChat';

function emit(content: Record<string, unknown>): void {
  useAnalystChat().ingestWsEvent(content);
}

describe('AnalystToaster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows analyst web-chat control actions and auto-fades', async () => {
    const wrapper = mount(AnalystToaster, { global: { plugins: [createPinia()] } });
    expect(wrapper.get('.analyst-toaster').attributes('role')).toBe('status');
    emit({ event: 'control_action_recorded', id: 'a1', actor: 'analyst', surface: 'web-chat', action: 'card.update', target_id: 'c-x' });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Analyst card.update on c-x');
    vi.advanceTimersByTime(4000);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Analyst card.update on c-x');
  });

  it('caps visible toasts at three', async () => {
    const wrapper = mount(AnalystToaster, { global: { plugins: [createPinia()] } });
    emit({ event: 'control_action_recorded', id: 'a1', actor: 'analyst', surface: 'web-chat', action: 'x', target_id: '1' });
    emit({ event: 'control_action_recorded', id: 'a2', actor: 'analyst', surface: 'web-chat', action: 'y', target_id: '2' });
    emit({ event: 'control_action_recorded', id: 'a3', actor: 'analyst', surface: 'web-chat', action: 'z', target_id: '3' });
    emit({ event: 'control_action_recorded', id: 'a4', actor: 'analyst', surface: 'web-chat', action: 'w', target_id: '4' });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.toast')).toHaveLength(3);
    expect(wrapper.text()).toContain('Analyst w on 4');
  });
});
