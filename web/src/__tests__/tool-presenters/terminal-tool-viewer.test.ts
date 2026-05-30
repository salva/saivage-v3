import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RawLlmExchangePanel from '../../components/agents/RawLlmExchangePanel.vue';
import { useAgentStore } from '../../stores/agents';
import type { LlmExchange } from '../../api/contracts';

type ExchangeAttempt = LlmExchange['attempts'][number];

function makeAttempt(overrides: Partial<ExchangeAttempt> = {}): ExchangeAttempt {
  return {
    attempt: 0,
    startedAt: '2026-05-23T10:00:00Z',
    completedAt: '2026-05-23T10:00:01Z',
    status: 'ok',
    terminalTool: null,
    request: { endpoint: 'https://api.example.com/v1/chat', method: 'POST', headers: {}, body: {} },
    response: { status: 200, headers: {}, bodyRaw: '{}', bodyParsed: {} },
    ...overrides,
  };
}

function makeExchange(attempt: ExchangeAttempt): LlmExchange {
  return {
    sessionId: 'sess-1',
    contract_id: 'executor.v1',
    capturedAt: '2026-05-23T10:00:01Z',
    transport: 'generic',
    candidate: { provider: 'openai', model: 'gpt-4', account: 'default' },
    attempts: [attempt],
  };
}

async function mountWithExchange(exchange: LlmExchange) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useAgentStore();
  store.currentLlmExchange = exchange;
  store.llmExchangeSessionId = 'sess-1';
  store.llmExchangeLoading = false;
  store.llmExchangeError = null;
  const wrapper = mount(RawLlmExchangePanel, {
    props: { sessionId: 'sess-1' },
    global: { plugins: [pinia] },
  });
  await flushPromises();
  return wrapper;
}

describe('RawLlmExchangePanel terminal_tool badge', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  for (const name of ['emit_planner_result', 'emit_executor_result', 'emit_reviewer_result'] as const) {
    it(`renders the terminal_tool badge with ${name}`, async () => {
      const wrapper = await mountWithExchange(makeExchange(makeAttempt({ terminalTool: name })));
      const badge = wrapper.find('.rlp-terminal-tool-badge');
      expect(badge.exists()).toBe(true);
      expect(badge.text()).toBe(name);
    });
  }

  it('omits the badge when terminalTool is null', async () => {
    const wrapper = await mountWithExchange(makeExchange(makeAttempt({ terminalTool: null })));
    expect(wrapper.find('.rlp-terminal-tool-badge').exists()).toBe(false);
  });
});
