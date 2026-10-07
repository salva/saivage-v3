import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RawLlmExchangePanel from '../components/agents/RawLlmExchangePanel.vue';
import CodeBlock from '../components/content/CodeBlock.vue';
import type { ProviderExchangePayload } from '../api/contracts';
import { useAgentStore } from '../stores/agents';

const live = vi.hoisted(() => ({ openLlmExchange: vi.fn(), close: vi.fn() }));
vi.mock('../stores/sync', () => ({ useSyncStore: () => live }));
beforeEach(() => { live.close.mockClear(); live.openLlmExchange.mockClear(); });

function exchange(overrides: Partial<ProviderExchangePayload> = {}): ProviderExchangePayload {
  return {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic',
    provider: 'test-provider',
    model: 'test-model',
    source_input_id: 'planner:card:1',
    attempt_index: 0,
    request_params: {
      endpoint: 'https://provider.test/v1/chat/completions',
      method: 'POST',
      temperature: 0,
      max_tokens: 1000,
      stream: false,
      offered_tools_count: 1,
    },
    started_at: '2026-05-23T10:00:00.000Z',
    completed_at: '2026-05-23T10:00:01.000Z',
    status: 'ok',
    response_status: 200,
    terminal_tool_fired: 'emit_result',
    assistant_output_ids: ['planner:card:1:tool-call:call-1'],
    ...overrides,
  } as ProviderExchangePayload;
}

function mountPanel(payload: ProviderExchangePayload | null) {
  setActivePinia(createPinia());
  const store = useAgentStore();
  const begin = vi.spyOn(store, 'beginLlmExchangeSelection');
  const fetch = vi.spyOn(store, 'fetchLlmExchange').mockImplementation(async () => {
    store.currentLlmExchange = payload;
    store.llmExchangeLoaded = true;
  });
  const clear = vi.spyOn(store, 'clearLlmExchange');
  live.openLlmExchange.mockImplementation((_id, callback) => {
    void callback(null);
    return live.close;
  });
  const wrapper = mount(RawLlmExchangePanel, { props: { sessionId: 'agent:planner:project' } });
  return { wrapper, store, begin, fetch, clear };
}

describe('RawLlmExchangePanel', () => {
  it.each([
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 },
    { cached_input_tokens: 0 },
  ])('renders exact reported usage in copyable settlement without fabricated counts %#', async token_usage => {
    const { wrapper } = mountPanel(exchange({ token_usage })); await flushPromises();
    const block = wrapper.findAllComponents(CodeBlock)[1];
    expect(JSON.parse(block.props('code')).token_usage).toEqual(token_usage);
    expect(block.props('copyable')).toBe(true);
    expect(block.find('.json-token-key').exists()).toBe(true);
    expect(block.find('code').element.textContent).toBe(block.props('code'));
    expect(wrapper.text()).toContain('unknown, not zero');
    expect(wrapper.text()).toContain('Cached input is part of input');
    expect(wrapper.text()).not.toContain('Token usage not reported');
    wrapper.unmount();
  });
  it('labels unreported successful usage without creating JSON counters', async () => {
    const { wrapper } = mountPanel(exchange()); await flushPromises();
    expect(wrapper.text()).toContain('Token usage not reported');
    expect(JSON.parse(wrapper.findAllComponents(CodeBlock)[1].props('code'))).not.toHaveProperty('token_usage');
    wrapper.unmount();
  });
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
    expect(live.close).toHaveBeenCalledOnce();
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
    const { wrapper } = mountPanel(
      exchange({
        status: 'error',
        terminal_conversation_output_id: null,
        error: { name: 'LlmRequestError', message: 'rate limited', status: 429 },
        response_status: 429,
        assistant_output_ids: undefined,
      } as Partial<ProviderExchangePayload>),
    );
    await flushPromises();
    expect(wrapper.find('.rlp-error-box').text()).toContain('LlmRequestError');
    expect(wrapper.find('.rlp-error-box').text()).toContain('rate limited');
    expect(wrapper.text()).not.toContain('Token usage not reported');
  });

  it('renders an accepted 404-style empty result without an error', async () => {
    const { wrapper } = mountPanel(null);
    await flushPromises();
    expect(wrapper.text()).toContain('No LLM exchange recorded');
    expect(wrapper.text()).not.toContain('Token usage not reported');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
