import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RawLlmExchangePanel from '../components/agents/RawLlmExchangePanel.vue';
import CodeBlock from '../components/content/CodeBlock.vue';
import type { ProviderExchangePayload } from '../api/contracts';
import { useAgentStore } from '../stores/agents';

function exchange(overrides: Partial<ProviderExchangePayload> = {}): ProviderExchangePayload {
  return {
    contract_id: 'planner.v1', contract_name: 'planner', transport: 'generic', provider: 'test-provider', model: 'test-model',
    source_input_id: 'planner:card:1', attempt_index: 0, request_params: { endpoint: 'https://provider.test/v1/chat/completions', method: 'POST', temperature: 0, max_tokens: 1000, stream: false, offered_tools_count: 1 },
    started_at: '2026-05-23T10:00:00.000Z', completed_at: '2026-05-23T10:00:01.000Z', status: 'ok', response_status: 200,
    terminal_tool_fired: 'emit_result', assistant_output_ids: ['planner:card:1:tool-call:call-1'], ...overrides,
  } as ProviderExchangePayload;
}

function mountPanel(payload: ProviderExchangePayload | null) {
  setActivePinia(createPinia());
  const store = useAgentStore();
  store.llmExchangeSessionId = 'agent:planner:project';
  store.currentLlmExchange = payload;
  store.llmExchangeLoaded = true;
  const begin = vi.spyOn(store, 'beginLlmExchangeSelection');
  const fetch = vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
  const clear = vi.spyOn(store, 'clearLlmExchange');
  const wrapper = mount(RawLlmExchangePanel, { props: { sessionId: 'agent:planner:project' } });
  return { wrapper, store, begin, fetch, clear };
}

describe('RawLlmExchangePanel', () => {
  it('claims and fetches once on mount, reuses its token for Refresh, and clears it on unmount', async () => {
    const { wrapper, begin, fetch, clear } = mountPanel(exchange());
    await flushPromises();
    expect(begin).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith('agent:planner:project');
    const token = begin.mock.results[0].value;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(token);

    await wrapper.find('.rlp-refresh').trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(token);

    wrapper.unmount();
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(token);
  });

  it('renders latest provider_exchange metadata without raw bodies', async () => {
    const { wrapper } = mountPanel(exchange());
    await flushPromises();
    expect(wrapper.text()).toContain('Completed:');
    expect(wrapper.text()).toContain('test-model');
    expect(wrapper.text()).toContain('emit_result');
    expect(wrapper.text()).toContain('Raw HTTP request and response bodies are not persisted');
    const blocks = wrapper.findAllComponents(CodeBlock);
    expect(blocks[0].props('code')).toContain('temperature');
    expect(blocks[0].props('code')).not.toContain('phase');
    expect(blocks[1].props('code')).toContain('assistant_output_ids');
    expect(blocks[1].props('code')).not.toContain('bodyRaw');
  });

  it('renders structured error metadata', async () => {
    const { wrapper } = mountPanel(exchange({ status: 'error', error: { name: 'LlmRequestError', message: 'rate limited', status: 429 }, response_status: 429, assistant_output_ids: undefined } as Partial<ProviderExchangePayload>));
    await flushPromises();
    expect(wrapper.find('.rlp-error-box').text()).toContain('LlmRequestError');
    expect(wrapper.find('.rlp-error-box').text()).toContain('rate limited');
  });

  it('renders an accepted 404-style empty result without an error', async () => {
    const { wrapper } = mountPanel(null);
    await flushPromises();
    expect(wrapper.text()).toContain('No LLM exchange recorded');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
