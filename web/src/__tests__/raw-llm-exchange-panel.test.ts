import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RawLlmExchangePanel from '../components/agents/RawLlmExchangePanel.vue';
import CodeBlock from '../components/content/CodeBlock.vue';
import { useAgentStore } from '../stores/agents';
import { formatJson } from '../utils/format-json';
import type { LlmExchange } from '../api/contracts';

type ExchangeAttempt = LlmExchange['attempts'][number];

function makeAttempt(overrides: Partial<ExchangeAttempt> = {}): ExchangeAttempt {
  return {
    attempt: 0,
    startedAt: '2026-05-23T10:00:00Z',
    completedAt: '2026-05-23T10:00:01Z',
    status: 'ok',
    terminalTool: null,
    request: {
      endpoint: 'https://api.example.com/v1/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
      body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyRaw: '{"hello":"world"}',
      bodyParsed: { hello: 'world' },
    },
    ...overrides,
  };
}

function makeExchange(overrides: Partial<LlmExchange> = {}): LlmExchange {
  return {
    sessionId: 'sess-1',
    contract_id: 'executor.v1',
    capturedAt: '2026-05-23T10:00:01Z',
    transport: 'generic',
    candidate: { provider: 'openai', model: 'gpt-4', account: 'default' },
    attempts: [makeAttempt()],
    ...overrides,
  };
}

function mountPanel(sessionId = 'sess-1') {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(RawLlmExchangePanel, {
    props: { sessionId },
    global: { plugins: [pinia] },
  });
}

describe('RawLlmExchangePanel', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('shows loading state', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.llmExchangeLoading = true;
    store.llmExchangeSessionId = 'sess-1';
    const fetchSpy = vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Loading raw LLM exchange');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows empty-state message when there is no exchange and no error', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.llmExchangeSessionId = 'sess-1';
    store.currentLlmExchange = null;
    store.llmExchangeError = null;
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('No LLM exchange recorded yet for this session.');
    expect(wrapper.find('.rlp-refresh').exists()).toBe(true);
  });

  it('shows error banner when llmExchangeError is set', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.llmExchangeSessionId = 'sess-1';
    store.llmExchangeError = 'Boom';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Boom');
    expect(wrapper.find('.rlp-status--error').exists()).toBe(true);
    expect(wrapper.find('.rlp-refresh').exists()).toBe(true);
  });

  it('renders header, redaction banner, and two CodeBlocks for a single ok attempt', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    const exchange = makeExchange();
    store.currentLlmExchange = exchange;
    store.llmExchangeSessionId = 'sess-1';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Captured:');
    expect(wrapper.text()).toContain('2026-05-23T10:00:01Z');
    expect(wrapper.text()).toContain('Transport:');
    expect(wrapper.text()).toContain('generic');
    expect(wrapper.text()).toContain('Model:');
    expect(wrapper.text()).toContain('gpt-4');
    expect(wrapper.text()).toContain('Attempts:');
    expect(wrapper.text()).toContain('after server-side redaction');
    expect(wrapper.find('.rlp-tabs').exists()).toBe(false);
    const blocks = wrapper.findAllComponents(CodeBlock);
    expect(blocks.length).toBe(2);
    const reqProps = blocks[0].props() as { code: string; language: string };
    const resProps = blocks[1].props() as { code: string; language: string };
    expect(reqProps.code).toBe(formatJson(exchange.attempts[0].request));
    expect(reqProps.language).toBe('json');
    expect(resProps.code).toBe(formatJson({ hello: 'world' }));
    expect(resProps.language).toBe('json');
  });

  it('shows tab strip for multi-attempt and defaults to the last attempt', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    const errAttempt = makeAttempt({
      attempt: 0,
      status: 'error',
      response: undefined,
      error: { errorName: 'CodexUnsupportedMaxOutputTokens', message: 'retry', bodyRaw: 'oops' },
    });
    const okAttempt = makeAttempt({ attempt: 1 });
    store.currentLlmExchange = makeExchange({ attempts: [errAttempt, okAttempt] });
    store.llmExchangeSessionId = 'sess-1';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    const tabs = wrapper.findAll('.rlp-attempt-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[1].attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('.rlp-error-box').exists()).toBe(false);

    await tabs[0].trigger('click');
    await flushPromises();
    expect(tabs[0].attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('.rlp-error-box').exists()).toBe(true);
    expect(wrapper.text()).toContain('CodexUnsupportedMaxOutputTokens');
  });

  it('renders raw text and a notice when response.bodyParsed is null', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.currentLlmExchange = makeExchange({
      attempts: [
        makeAttempt({
          response: { status: 502, bodyRaw: '<html>error</html>', bodyParsed: null },
        }),
      ],
    });
    store.llmExchangeSessionId = 'sess-1';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Response was not valid JSON');
    const blocks = wrapper.findAllComponents(CodeBlock);
    const responseBlock = blocks[blocks.length - 1];
    const respProps = responseBlock.props() as { code: string; language: string };
    expect(respProps.language).toBe('text');
    expect(respProps.code).toBe('<html>error</html>');
  });

  it('renders streaming response with raw stream and a collapsible parsed details block', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    const raw = 'data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\n';
    store.currentLlmExchange = makeExchange({
      transport: 'codex',
      attempts: [
        makeAttempt({
          response: {
            status: 200,
            bodyRaw: raw,
            bodyParsed: { content: 'ab' },
          },
        }),
      ],
    });
    store.llmExchangeSessionId = 'sess-1';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(wrapper.find('details.rlp-parsed-details').exists()).toBe(true);
    const blocks = wrapper.findAllComponents(CodeBlock);
    // [request, raw stream, parsed]
    expect(blocks.length).toBe(3);
    const streamProps = blocks[1].props() as { code: string; language: string };
    const parsedProps = blocks[2].props() as { code: string; language: string };
    expect(streamProps.language).toBe('text');
    expect(streamProps.code).toBe(raw);
    expect(parsedProps.language).toBe('json');
    expect(parsedProps.code).toBe(formatJson({ content: 'ab' }));
  });

  it('renders an error attempt with errorName, message, and bodyRaw as text CodeBlock', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.currentLlmExchange = makeExchange({
      attempts: [
        makeAttempt({
          status: 'error',
          response: undefined,
          error: { errorName: 'SyntaxError', message: 'bad json', bodyRaw: 'not-json' },
        }),
      ],
    });
    store.llmExchangeSessionId = 'sess-1';
    vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    const errBox = wrapper.find('.rlp-error-box');
    expect(errBox.exists()).toBe(true);
    expect(errBox.text()).toContain('SyntaxError');
    expect(errBox.text()).toContain('bad json');
    const blocks = wrapper.findAllComponents(CodeBlock);
    const bodyBlock = blocks[blocks.length - 1];
    const bodyProps = bodyBlock.props() as { code: string; language: string };
    expect(bodyProps.language).toBe('text');
    expect(bodyProps.code).toBe('not-json');
  });

  it('Refresh button calls fetchLlmExchange with the current sessionId', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.currentLlmExchange = makeExchange();
    store.llmExchangeSessionId = 'sess-1';
    const fetchSpy = vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    const wrapper = mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    fetchSpy.mockClear();
    await wrapper.find('.rlp-refresh').trigger('click');
    await flushPromises();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('sess-1');
  });

  it('auto-fetches on mount only when cached session id differs from prop', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentStore();
    store.llmExchangeSessionId = 'sess-1';
    store.currentLlmExchange = makeExchange();
    const fetchSpy = vi.spyOn(store, 'fetchLlmExchange').mockResolvedValue(undefined);
    mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-1' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(fetchSpy).not.toHaveBeenCalled();

    mount(RawLlmExchangePanel, {
      props: { sessionId: 'sess-2' },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('sess-2');
  });

  it('always renders the redaction banner above the panes', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.rlp-redaction-banner').exists()).toBe(true);
  });
});
