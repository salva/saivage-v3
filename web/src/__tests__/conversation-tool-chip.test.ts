import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import { buildToolDisplay, type ToolDisplayModel } from '../utils/tool-friendly';
import type { ToolPair } from '../utils/agent-timeline';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

const unmatchedRead: ToolDisplayModel = {
  action: 'Read',
  toolName: 'read',
  target: [],
  links: [{ kind: 'file', root: 'meta', path: '.saivage/plan.json' }],
  status: [{ kind: 'text', text: 'no result recorded' }],
  statusTone: 'neutral',
  known: true,
};

function toolPair(tool: string, resultContent: string | null, args: Record<string, unknown> = {}): ToolPair {
  const callContent = JSON.stringify({ role: 'assistant', tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
  const base = { session_id: 'agent:analyst:global', round_id: 'r', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00Z', tool, tool_call_id: `call-${tool}` };
  return {
    call: { ...base, id: 'call', role: 'assistant', kind: 'tool_call', content: callContent },
    result: resultContent === null ? null : { ...base, id: 'result', role: 'tool', kind: 'tool_result', content: resultContent },
  } as ToolPair;
}

describe('ToolChip', () => {
  it('uses a group with one expand button and sibling router links without nested anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: unmatchedRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.findAll('button.tool-chip-toggle')).toHaveLength(1);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.find('.tool-chip-links').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-links a').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-main > button.tool-chip-toggle + .tool-chip-links').exists()).toBe(true);
  });

  it('emits toggle and renders formatted detail when expanded', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: unmatchedRead, callContent: '{}', resultContent: null, expanded: true, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
  });

  it('renders timestamp in a human-friendly form instead of raw ISO', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const ts = '2026-05-30T06:50:18.761Z';
    const wrapper = mount(ToolChip, { props: { display: unmatchedRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-ts', timestamp: ts }, global: { plugins: [r, createPinia()] } });
    const span = wrapper.find('.tool-chip-time');
    expect(span.exists()).toBe(true);
    expect(span.text()).not.toBe(ts);
    expect(span.text()).toMatch(/ago|just now|\bm\b|\bh\b|\bd\b|2026/i);
    expect(span.attributes('title')).toBeTruthy();
  });

  it('does not render raw payloads by default when expanded and only reveals them via the raw toggles', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const rawRequest = JSON.stringify({ role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });
    const rawResponse = JSON.stringify({ ok: true, content: 'secret-value' });
    const okRead: ToolDisplayModel = { action: 'Read', toolName: 'read', target: [], links: [], status: [{ kind: 'text', text: '2 lines' }], statusTone: 'ok', known: true };
    const wrapper = mount(ToolChip, { props: { display: okRead, callContent: rawRequest, resultContent: rawResponse, expanded: true, detailsId: 'tool-raw' }, global: { plugins: [r, createPinia()] } });

    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('secret-value');
    expect(wrapper.findAll('.tool-chip-raw')).toHaveLength(0);

    const toggles = wrapper.findAll('button.raw-toggle');
    expect(toggles).toHaveLength(2);

    await toggles[1].trigger('click');
    const raw = wrapper.findAll('.tool-chip-raw');
    expect(raw.map((n) => n.text()).join('\n')).toContain('secret-value');
  });

  it('shows current MCP completeness and source size while keeping the exact result raw-only', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const resultContent = JSON.stringify({ success: true, data: { result: 'private-mcp-prefix', result_complete: false, result_utf8_bytes: 4096 } });
    const pair = toolPair('mcp_tool_call', resultContent, { serverName: 'server', toolName: 'lookup', args: {} });
    const wrapper = mount(ToolChip, { props: { display: buildToolDisplay(pair), callContent: pair.call.content, resultContent, expanded: true, detailsId: 'tool-mcp' }, global: { plugins: [r, createPinia()] } });

    const statusParts = wrapper.find('.tool-chip-status').findAll('.inline-part-text').map((part) => part.text());
    expect(statusParts).toEqual(['MCP call completed', 'result truncated · 4.0 kB total JSON source']);
    expect(wrapper.find('.tool-chip-status').attributes('data-tone')).toBe('ok');
    expect(wrapper.find('.tool-chip-body').text()).toContain('result truncated · 4.0 kB total JSON source');
    expect(wrapper.text()).not.toContain('private-mcp-prefix');

    const rawResponseToggle = wrapper.findAll('button.raw-toggle').find((button) => button.text() === 'Show raw response');
    expect(rawResponseToggle).toBeDefined();
    await rawResponseToggle!.trigger('click');
    expect(wrapper.find('[aria-label="Raw tool response"]').text()).toContain(resultContent);
  });

  it('keeps failure data and every malformed response raw-only through built displays', async () => {
    const longError = `permission denied ${'x'.repeat(140)}`;
    const boundedError = `${longError.slice(0, 119)}…`;
    const cases = [
      { body: JSON.stringify({ success: false, error: longError, data: { marker: 'failure-data-secret' } }), semantic: boundedError, hidden: 'failure-data-secret', tone: 'error' },
      { body: JSON.stringify({ success: true, error: 'success-error-secret', data: { marker: 'success-data-secret' } }), semantic: 'result unavailable', hidden: 'success-error-secret', tone: 'ok' },
      { body: JSON.stringify({ success: false }), semantic: 'result unavailable', hidden: '"success":false', tone: 'ok' },
      { body: JSON.stringify({ success: false, error: { message: 'non-string-error-secret' } }), semantic: 'result unavailable', hidden: 'non-string-error-secret', tone: 'ok' },
      { body: JSON.stringify({ marker: 'object-secret' }), semantic: 'result unavailable', hidden: 'object-secret', tone: 'ok' },
      { body: JSON.stringify(['array-secret']), semantic: 'result unavailable', hidden: 'array-secret', tone: 'ok' },
      { body: JSON.stringify('json-string-secret'), semantic: 'result unavailable', hidden: 'json-string-secret', tone: 'ok' },
      { body: JSON.stringify(42), semantic: 'result unavailable', hidden: '42', tone: 'ok' },
      { body: 'null', semantic: 'result unavailable', hidden: 'null', tone: 'ok' },
      { body: 'plain-text-secret', semantic: 'result unavailable', hidden: 'plain-text-secret', tone: 'ok' },
      { body: '{invalid-json-secret', semantic: 'result unavailable', hidden: 'invalid-json-secret', tone: 'ok' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const r = router(); await r.push('/'); await r.isReady();
      const pair = toolPair('read', testCase.body, { path: 'README.md' });
      const wrapper = mount(ToolChip, { props: { display: buildToolDisplay(pair), callContent: pair.call.content, resultContent: testCase.body, expanded: false, detailsId: `tool-matrix-${index}` }, global: { plugins: [r, createPinia()] } });
      expect(wrapper.find('.tool-chip-status').text()).toBe(testCase.semantic);
      expect(wrapper.text()).not.toContain(testCase.hidden);
      expect(wrapper.find('.tool-chip-status').attributes('data-tone')).toBe(testCase.tone);

      await wrapper.setProps({ expanded: true });
      expect(wrapper.find('.tool-chip-body').text()).toContain(testCase.semantic);
      expect(wrapper.find('.tool-chip-body').text()).not.toContain(testCase.hidden);
      expect(wrapper.findAll('.tool-chip-raw')).toHaveLength(0);

      const rawResponseToggle = wrapper.findAll('button.raw-toggle').find((button) => button.text() === 'Show raw response');
      expect(rawResponseToggle).toBeDefined();
      await rawResponseToggle!.trigger('click');
      expect(wrapper.find('[aria-label="Raw tool response"]').text()).toContain(testCase.body);
      wrapper.unmount();
    }
  });

  it('renders an expanded unmatched unknown call as neutral fact with request-only raw access', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const pair = toolPair('custom_probe', null, { exact: 'request-payload' });
    const wrapper = mount(ToolChip, { props: { display: buildToolDisplay(pair), callContent: pair.call.content, resultContent: null, expanded: true, detailsId: 'tool-unmatched-unknown' }, global: { plugins: [r, createPinia()] } });

    expect(wrapper.text()).toContain('no result recorded');
    expect(wrapper.find('.tool-chip-status').attributes('data-tone')).toBe('neutral');
    expect(wrapper.find('.tool-chip-field dd[data-tone="neutral"]').text()).toBe('no result recorded');
    expect(wrapper.classes()).not.toContain('tool-chip-ok');
    expect(wrapper.classes()).not.toContain('tool-chip-error');
    expect(wrapper.classes()).not.toContain('tool-chip-pending');
    expect(wrapper.find('.detail-hint').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Generic tool');
    expect(wrapper.text()).not.toContain('raw response');
    expect(wrapper.find('[aria-label="Raw tool response"]').exists()).toBe(false);

    const toggles = wrapper.findAll('button.raw-toggle');
    expect(toggles).toHaveLength(1);
    expect(toggles[0].text()).toBe('Show raw request');
    await toggles[0].trigger('click');
    expect(wrapper.find('[aria-label="Raw tool request"]').text()).toContain('request-payload');
  });

  it('keeps the generic hint and raw response access for an unknown tool with a recorded result', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const resultContent = JSON.stringify({ success: true, data: { exact: 'response-payload' } });
    const pair = toolPair('custom_probe', resultContent, { exact: 'request-payload' });
    const wrapper = mount(ToolChip, { props: { display: buildToolDisplay(pair), callContent: pair.call.content, resultContent, expanded: true, detailsId: 'tool-unknown-result' }, global: { plugins: [r, createPinia()] } });

    expect(wrapper.find('.detail-hint').text()).toBe('Generic tool — view raw payload for full detail.');
    expect(wrapper.findAll('button.raw-toggle').map((button) => button.text())).toEqual(['Show raw request', 'Show raw response']);
    await wrapper.findAll('button.raw-toggle')[1].trigger('click');
    expect(wrapper.find('[aria-label="Raw tool response"]').text()).toContain('response-payload');
  });
});
