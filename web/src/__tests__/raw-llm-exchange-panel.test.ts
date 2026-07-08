import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import RawLlmExchangePanel from '../components/agents/RawLlmExchangePanel.vue';
import { useAgentStore } from '../stores/agents';
import type { ProviderExchangePayload } from '../api/contracts';
import CodeBlock from '../components/content/CodeBlock.vue';

function exchange(overrides: Partial<ProviderExchangePayload> = {}): ProviderExchangePayload {
  return {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic',
    provider: 'test-provider',
    model: 'test-model',
    source_input_id: 'planner:card:1',
    attempt_index: 0,
    request_params: { temperature: 0, max_tokens: 1000 },
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
  store.currentLlmExchange = payload;
  store.llmExchangeSessionId = 'planner:card';
  vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
  return mount(RawLlmExchangePanel, { props: { sessionId: 'planner:card' } });
}

describe('RawLlmExchangePanel', () => {
  it('renders latest provider_exchange metadata without raw bodies', async () => {
    const wrapper = mountPanel(exchange());
    await flushPromises();
    expect(wrapper.text()).toContain('Completed:');
    expect(wrapper.text()).toContain('test-model');
    expect(wrapper.text()).toContain('emit_result');
    expect(wrapper.text()).toContain('Raw HTTP request and response bodies are not persisted');
    const blocks = wrapper.findAllComponents(CodeBlock);
    expect(blocks[0].props('code')).toContain('temperature');
    expect(blocks[1].props('code')).toContain('assistant_output_ids');
    expect(blocks[1].props('code')).not.toContain('bodyRaw');
  });

  it('renders structured error metadata', async () => {
    const wrapper = mountPanel(exchange({ status: 'error', error: { name: 'LlmRequestError', message: 'rate limited', status: 429 }, response_status: 429, assistant_output_ids: undefined } as Partial<ProviderExchangePayload>));
    await flushPromises();
    expect(wrapper.find('.rlp-error-box').text()).toContain('LlmRequestError');
    expect(wrapper.find('.rlp-error-box').text()).toContain('rate limited');
  });
});
