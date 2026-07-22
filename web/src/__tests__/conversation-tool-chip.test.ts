import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import { buildToolDisplay, type ToolDisplayModel } from '../utils/tool-friendly';
import type { ToolPair } from '../utils/agent-timeline';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

const pendingRead: ToolDisplayModel = {
  action: 'Read',
  toolName: 'read',
  target: [],
  links: [{ kind: 'file', root: 'meta', path: '.saivage/plan.json' }],
  status: [{ kind: 'text', text: 'running…' }],
  statusTone: 'pending',
  known: true,
};

function readPair(resultContent: string, status: ToolPair['status']): ToolPair {
  const callContent = JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });
  const base = { session_id: 'analyst:global', round_id: 'r', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00Z', tool: 'read', tool_call_id: 'call-read' };
  return {
    call: { ...base, id: 'call', role: 'assistant', kind: 'tool_call', content: callContent },
    result: { ...base, id: 'result', role: 'tool', kind: 'tool_result', content: resultContent },
    status,
  } as ToolPair;
}

describe('ToolChip', () => {
  it('uses a group with one expand button and sibling router links without nested anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.findAll('button.tool-chip-toggle')).toHaveLength(1);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.find('.tool-chip-links').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-links a').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-main > button.tool-chip-toggle + .tool-chip-links').exists()).toBe(true);
  });

  it('emits toggle and renders formatted detail when expanded', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: true, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
  });

  it('renders timestamp in a human-friendly form instead of raw ISO', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const ts = '2026-05-30T06:50:18.761Z';
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-ts', timestamp: ts }, global: { plugins: [r, createPinia()] } });
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

  it('keeps failure data and every malformed response raw-only through built displays', async () => {
    const longError = `permission denied ${'x'.repeat(140)}`;
    const boundedError = `${longError.slice(0, 119)}…`;
    const cases = [
      { body: JSON.stringify({ success: false, error: longError, data: { marker: 'failure-data-secret' } }), status: 'error' as const, semantic: boundedError, hidden: 'failure-data-secret', tone: 'error' },
      { body: JSON.stringify({ success: true, error: 'success-error-secret', data: { marker: 'success-data-secret' } }), status: 'ok' as const, semantic: 'result unavailable', hidden: 'success-error-secret', tone: 'ok' },
      { body: JSON.stringify({ success: false }), status: 'ok' as const, semantic: 'result unavailable', hidden: '"success":false', tone: 'ok' },
      { body: JSON.stringify({ success: false, error: { message: 'non-string-error-secret' } }), status: 'ok' as const, semantic: 'result unavailable', hidden: 'non-string-error-secret', tone: 'ok' },
      { body: JSON.stringify({ marker: 'object-secret' }), status: 'ok' as const, semantic: 'result unavailable', hidden: 'object-secret', tone: 'ok' },
      { body: JSON.stringify(['array-secret']), status: 'ok' as const, semantic: 'result unavailable', hidden: 'array-secret', tone: 'ok' },
      { body: JSON.stringify('json-string-secret'), status: 'ok' as const, semantic: 'result unavailable', hidden: 'json-string-secret', tone: 'ok' },
      { body: JSON.stringify(42), status: 'ok' as const, semantic: 'result unavailable', hidden: '42', tone: 'ok' },
      { body: 'null', status: 'ok' as const, semantic: 'result unavailable', hidden: 'null', tone: 'ok' },
      { body: 'plain-text-secret', status: 'ok' as const, semantic: 'result unavailable', hidden: 'plain-text-secret', tone: 'ok' },
      { body: '{invalid-json-secret', status: 'ok' as const, semantic: 'result unavailable', hidden: 'invalid-json-secret', tone: 'ok' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const r = router(); await r.push('/'); await r.isReady();
      const pair = readPair(testCase.body, testCase.status);
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
});
