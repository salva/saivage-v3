import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import { buildToolDisplay } from '../utils/tool-friendly';
import type { TimelineRow } from '../utils/agent-timeline';
import { call, result, processData } from './tool-presenters/fixtures';

async function mounted(row: TimelineRow, expanded = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }, { path: '/cards/:id', name: 'card-detail', component: { template: '<div />' } }] });
  await router.push('/'); await router.isReady();
  return mount(ToolChip, { props: { entryId: row.entry.kind === 'tool_call' ? row.entry.id : row.mate?.id ?? row.entry.id, resultEntryId: row.entry.kind === 'tool_result' ? row.entry.id : row.mate?.id, display: buildToolDisplay(row), callContent: row.entry.kind === 'tool_call' ? row.entry.content : row.mate?.content ?? null, resultContent: row.entry.kind === 'tool_result' ? row.entry.content : row.mate?.content ?? null, expanded, detailsId: `details-${row.entry.id}` }, global: { plugins: [router] } });
}
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'clipboard'); });
describe('semantic ToolChip', () => {
  it('keeps native disclosure, exact name, opaque anchor, timestamp and independently focusable links', async () => {
    const c = call('read', { path: 'record:///brief.md?card=card-a' }, ' opaque "[] # % call ');
    const wrapper = await mounted({ entry: c, mate: result('read', {}) }, false);
    expect(wrapper.attributes('data-tool-entry-id')).toBe(c.id);
    expect(wrapper.find('.tool-chip-name').exists()).toBe(false);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.find('.tool-chip-target').text()).toBe('record:///brief.md?card=card-a');
    expect(wrapper.find('.tool-chip-links a').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-links a').text()).toBe('Open file');
    expect(wrapper.find('button.tool-chip-toggle').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.tool-chip-time').exists()).toBe(false);
    await wrapper.find('button.tool-chip-toggle').trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });
  it('opens semantic output coverage with independently disclosed stdout/stderr and actual Files links', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const wrapper = await mounted({ entry: result('run_command', processData), mate: call('run_command', { command: 'npm test' }) });
    expect(wrapper.text()).toContain('Exited · exit 0');
    expect(wrapper.text()).toContain('Head complete');
    expect(wrapper.findAll('.semantic-section details summary').map((s) => s.text())).toEqual(['Show stdout', 'Show stderr']);
    expect(wrapper.findAll('.semantic-section a')).toHaveLength(2);
    expect(wrapper.find('.semantic-section a').attributes('href')).toContain('stdout.log');
    expect(wrapper.findAll('.safe-original')).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['request', 'result'] as const)('copies exact received safe original %s through final character, independently of semantic shortening', async (kind) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const long = `prefix ${'long value '.repeat(200)}final\n`;
    const c = call('write', { path: 'output.txt', content: long });
    const r = result('write', { target: 'output.txt', written: true, bytes: long.length });
    const row = kind === 'request' ? { entry: c, mate: r } : { entry: { ...r, content: ` ${r.content}\n` }, mate: c };
    const wrapper = await mounted(row);
    const raw = wrapper.find(kind === 'request' ? '.tool-request .safe-original' : '.tool-result .safe-original');
    expect((raw.element as HTMLDetailsElement).open).toBe(false);
    (raw.element as HTMLDetailsElement).open = true;
    expect(raw.find('.json-token-key').exists()).toBe(true);
    expect(raw.find('code').element.textContent).toBe(row.entry.content);
    await raw.find('button.code-block__copy').trigger('click');
    expect(writeText).toHaveBeenLastCalledWith(row.entry.content);
    expect(raw.find('.code-block').classes()).toContain('code-block--wrap');
    await wrapper.setProps({ expanded: false });
    await wrapper.setProps({ expanded: true });
    expect((wrapper.find('.safe-original').element as HTMLDetailsElement).open).toBe(false);
  });
  it('keeps failure/uncertainty and known effects outside disclosures, while full error text stays accessible', async () => {
    const error = `Prior effects may or may not have happened. ${'detail '.repeat(100)}LAST`;
    const r = result('write', {}, { content: JSON.stringify({ success: false, error, data: { outcome_unknown: true, target: 'out', written: true, bytes: 4 } }) });
    const wrapper = await mounted({ entry: r, mate: call('write', { path: 'out', content: 'safe' }) }, false);
    expect(wrapper.find('.tool-chip-status').text()).toContain('Effects uncertain');
    expect(wrapper.find('.tool-chip-status').text()).toContain('Recorded domain outcome: Applied');
    expect(wrapper.find('.tool-chip-status').text()).toContain('Prior effects may or may not have happened');
    await wrapper.setProps({ expanded: true });
    expect(wrapper.text()).toContain('LAST');
    expect(wrapper.text()).toContain('written');
  });
  it('uses received safe values in content, attributes, links and copies without current enrichment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const c = call('write', { path: 'record:///brief.md?card=card-a', content: '[REDACTED]' });
    const before = c.content;
    const wrapper = await mounted({ entry: c, mate: null });
    await wrapper.find('.tool-request .safe-original button.code-block__copy').trigger('click');
    expect(wrapper.html()).not.toContain('CONFIDENTIALITY_CANARY');
    expect(writeText).toHaveBeenCalledWith(before);
    expect(c.content).toBe(before);
    expect(wrapper.text()).toContain('No result recorded');
  });
  it('keeps unexpected result projections non-green with secondary exact safe inspection', async () => {
    const r = result('read', {}, { content: '{"unexpected":true}' });
    const wrapper = await mounted({ entry: r, mate: null }, false);
    expect(wrapper.text()).toContain('Presentation unavailable');
    expect(wrapper.find('.tool-chip-status').attributes('data-tone')).toBe('error');
    await wrapper.setProps({ expanded: true });
    expect(wrapper.find('.tool-result .safe-original code').text()).toBe(r.content);
  });
});
