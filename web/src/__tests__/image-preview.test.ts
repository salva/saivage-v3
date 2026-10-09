import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ImagePreviewDialog from '../files/ImagePreviewDialog.vue';
import ConversationTimeline from '../components/conversation/ConversationTimeline.vue';
import { conversationImages } from '../utils/conversation-images';
import { entriesToTimeline } from '../utils/agent-timeline';
import type { AgentConversationEntry } from '../api/types';
import { getConversationImage, getFileImage } from '../api/client';
import { effectScope, nextTick, ref } from 'vue';
import { useAgentTimeline } from '../composables/useAgentTimeline';
import { call, result as toolResult } from './tool-presenters/fixtures';
vi.mock('../api/client', () => ({ getConversationImage: vi.fn(), getFileImage: vi.fn(), OperatorApiError: class extends Error {} }));
const context = { session_id: 'agent:analyst:global' as const, segment_version: 3, segment_id: '00000000-0000-4000-8000-000000000003' };
const image = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 800, height: 1600, byte_length: 100, sha256: '0'.repeat(64) };
const entry = (content: unknown): AgentConversationEntry => ({ id: 'source:tool-result:call', session_id: context.session_id, round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, role: 'tool', kind: 'tool_result', content: JSON.stringify(content), timestamp: '2026-10-08T00:00:00Z', tool: 'synthetic_typed_producer', tool_call_id: 'call' } as unknown as AgentConversationEntry);
const result = { success: true, data: { image_url: 'https://invalid', image }, content: [{ type: 'text', text: 'before' }, { type: 'image', image }, { type: 'text', text: 'between' }, { type: 'image', image }] };
describe('caller-local selected image preview', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() });
    vi.mocked(getConversationImage).mockResolvedValue(new Blob(['png']));
    vi.mocked(getFileImage).mockResolvedValue(new Blob(['png']));
    HTMLElement.prototype.scrollTo = vi.fn();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.innerHTML = ''; });
  it('uses actual ordered references without producer metadata, never nested JSON or URLs', async () => {
    const selections = conversationImages(entry(result), context, 'synthetic_typed_producer');
    expect(selections.map(s => s.locator)).toEqual([1, 3].map(content_index => ({ ...context, message_id: entry(result).id, content_index, image_id: image.id })));
    expect(selections[0].metadata).toBe('Original dimensions not recorded');
    expect(conversationImages(entry({ success: true, data: { image, image_url: 'https://invalid' } }), context, 'view_image')).toEqual([]);
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([entry(result)]), expandedIds: new Set<string>(), imageContext: context } });
    expect(wrapper.findAll('.image-actions button').map(b => b.text())).toEqual(['Inspect image · content 2 · 800 × 1600', 'Inspect image · content 4 · 800 × 1600']);
    await wrapper.findAll('.image-actions button')[1].trigger('click');
    await flushPromises();
    expect(getConversationImage).toHaveBeenCalledWith(selections[1].locator, expect.any(AbortSignal));
    await wrapper.setProps({ timeline: entriesToTimeline([entry(result), { ...entry(result), id: 'arrival', kind: 'text', role: 'assistant', content: 'Fresh arrival' }]) });
    await flushPromises();
    expect(getConversationImage).toHaveBeenCalledTimes(1); // same-selection refresh does not reset viewer mode/read
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  });
  it('preserves follow policy through inspection with no close-time catch-up jump', async () => {
    const scope = effectScope();
    const entries = ref<AgentConversationEntry[]>([]);
    const controls = scope.run(() => useAgentTimeline(entries))!;
    const area = document.createElement('div');
    Object.defineProperties(area, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    area.scrollTop = 80; controls.scrollAreaRef.value = area;
    controls.inspectingImage.value = true;
    entries.value = [entry(result)]; await nextTick();
    expect(area.scrollTop).toBe(80); expect(controls.pinnedToLatest.value).toBe(true); expect(controls.autoScrollPaused.value).toBe(false);
    controls.inspectingImage.value = false; await nextTick();
    expect(area.scrollTop).toBe(80);
    entries.value = [...entries.value, { ...entry(result), id: 'later:tool-result:call' }]; await nextTick();
    expect(area.scrollTop).toBe(500); // ordinary next arrival resumes prior follow policy
    scope.stop();
  });
  it('pins paired nonadjacent historical result identity and treats branded metadata as optional enrichment', () => {
    const metadata = { source_path: 'source.png', source_dimensions: { width: 1600, height: 3200 }, oriented_dimensions: { width: 1600, height: 3200 }, sent_dimensions: { width: 800, height: 1600 }, orientation_applied: false, resized: true, scale: { x: .5, y: .5 }, max_dimension: 1600 };
    const branded = entry({ success: true, data: metadata, content: [{ type: 'image', image }] });
    expect(conversationImages(branded, context, 'view_image')[0].metadata).toContain('Source 1600 × 3200');
    const { source_path: _path, ...nativeMetadata } = metadata;
    const native = entry({ ...result, data: { images: [{ content_index: 1, ...nativeMetadata }] } });
    expect(conversationImages(native, context, 'mcp_tool_call')[0].metadata).toContain('Orientation-adjusted 1600 × 3200');
    expect(conversationImages(native, context, 'mcp_tool_call')[1].metadata).toBe('Original dimensions not recorded');
    const call = { ...branded, id: 'source:tool-call:call', role: 'assistant' as const, kind: 'tool_call' as const, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'view_image', arguments: '{}' } }] }) };
    const between = { ...branded, id: 'between', role: 'assistant' as const, kind: 'text' as const, content: 'Before result' };
    const timeline = entriesToTimeline([call, between, branded]);
    const row = timeline.rounds[0].rows[0];
    expect(conversationImages(row.mate, context, 'view_image')[0].locator).toEqual({ ...context, message_id: branded.id, content_index: 0, image_id: image.id });
  });
  it('selects the exact result-owned image for each expanded repeated-ID exchange', async () => {
    const a = call('synthetic_typed_producer', { target: 'A' }, 'a', 'call_0');
    const b = call('synthetic_typed_producer', { target: 'B' }, 'b', 'call_0');
    const secondImage = { ...image, id: '00000000-0000-4000-8000-000000000002', sha256: 'b'.repeat(64) };
    const ar = toolResult('synthetic_typed_producer', {}, { tool_call_id: 'call_0', content: JSON.stringify({ success: true, content: [{ type: 'image', image }] }) }, 'a');
    const br = toolResult('synthetic_typed_producer', {}, { tool_call_id: 'call_0', content: JSON.stringify({ success: true, content: [{ type: 'text', text: 'B only' }, { type: 'image', image: secondImage }] }) }, 'b');
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([a, ar, b, br]), expandedIds: new Set([a.id, b.id]), imageContext: context } });
    expect(wrapper.findAll('[data-entry-id]').map(node => node.attributes('data-entry-id'))).toEqual([a.id, ar.id, b.id, br.id]);
    for (const [index, r, descriptor, content_index] of [[0, ar, image, 0], [1, br, secondImage, 1]] as const) {
      await wrapper.findAll('.tool-chip')[index].get('.image-actions button').trigger('click'); await flushPromises();
      expect(getConversationImage).toHaveBeenLastCalledWith({ ...context, message_id: r.id, content_index, image_id: descriptor.id }, expect.any(AbortSignal));
      const close = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Close / Return'))!;
      close.click(); await flushPromises();
    }
    wrapper.unmount();
  });
  it('clears replaced pixels, aborts and ignores departed successes; unmount revokes accepted URLs', async () => {
    const selections = conversationImages(entry(result), context, 'mcp_tool_call');
    const wrapper = mount(ImagePreviewDialog, { props: { selection: { kind: 'conversation', image: selections[0] } }, attachTo: document.body });
    await flushPromises();
    expect(document.querySelector('img')?.src).toBe('blob:synthetic');
    let late!: (blob: Blob) => void;
    vi.mocked(getConversationImage).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const oldSignal = vi.mocked(getConversationImage).mock.calls[0][1]!;
    await wrapper.setProps({ selection: { kind: 'conversation', image: selections[1] } });
    expect(oldSignal.aborted).toBe(true);
    expect(document.querySelector('img')).toBeNull();
    await wrapper.setProps({ selection: { kind: 'file', path: 'fresh.png' } });
    await flushPromises();
    late(new Blob(['late'])); await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(getFileImage).toHaveBeenCalledWith('fresh.png', expect.any(AbortSignal));
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('fails explicitly without retaining old pixels and reports dimensions of fetched Files bytes', async () => {
    const wrapper = mount(ImagePreviewDialog, { props: { selection: { kind: 'file', path: 'fresh.png' } }, attachTo: document.body });
    await flushPromises();
    const img = document.querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 13 }, naturalHeight: { value: 7 } });
    img.dispatchEvent(new Event('load')); await flushPromises();
    expect(document.body.textContent).toContain('Decoded 13 × 7');
    vi.mocked(getFileImage).mockRejectedValueOnce(new Error('failed'));
    await wrapper.setProps({ selection: { kind: 'file', path: 'missing.png' } }); await flushPromises();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('Image preview failed');
    wrapper.unmount();
  });
});
