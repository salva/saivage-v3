import { expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';
import { mount } from '@vue/test-utils';
import ConversationTimeline from '../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline } from '../utils/agent-timeline';
import { call, result } from './tool-presenters/fixtures';
import { buildToolDisplay, inlinePartsText } from '../utils/tool-friendly';

it('renders/copies only recorded image metadata without asserting delivery or linking source pixels', () => {
  const raw = JSON.stringify({ success: true, content: [{ type: 'image', image: { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 1600, height: 800, byte_length: 1000, sha256: 'a'.repeat(64) } }], data: { source_path: 'screen.png', source_dimensions: { width: 2048, height: 1024 }, oriented_dimensions: { width: 2048, height: 1024 }, sent_dimensions: { width: 1600, height: 800 }, orientation_applied: false, resized: true, scale: { x: 0.78125, y: 0.78125 }, max_dimension: 1600 } });
  const result = presentToolResult(raw, { tool: 'view_image' });
  expect(result.outcome).toBe('Image snapshot recorded');
  expect(result.headline).toEqual([{ kind: 'text', text: 'sent 1600 × 800' }]);
  expect(result.sections.some(section => section.content?.includes('sha256'))).toBe(true);
  const call = presentToolCall(JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'view_image', arguments: '{"path":"screen.png"}' } }] }));
  expect(call.sections.flatMap(section => section.fields ?? []).every(field => field.parts.every(part => part.kind === 'text'))).toBe(true);
  expect(call.headline.every(part => part.kind === 'text')).toBe(true);
  const copy = JSON.stringify({ call, result, raw });
  expect(copy).toContain('screen.png');
  expect(copy).not.toMatch(/data:image|base64|\/images\/|model saw|kind\\":\\"file/);
  expect(presentToolResult('{"success":false,"error":"Invalid PNG/JPEG"}', { tool: 'view_image' }).outcome).toBe('Failed · Image snapshot not recorded');
});

it('keeps image paths plain text in both halves, including complete metadata-only RAW', () => {
  const c = call('view_image', { path: 'screen.png', max_dimension: 800 });
  const descriptor = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 800, height: 400, byte_length: 1000, sha256: 'a'.repeat(64) };
  const r = result('view_image', {}, { content: JSON.stringify({ success: true, content: [{ type: 'image', image: descriptor }], data: { source_path: 'screen.png', source_dimensions: { width: 1600, height: 800 }, oriented_dimensions: { width: 1600, height: 800 }, sent_dimensions: { width: 800, height: 400 }, orientation_applied: false, resized: true, scale: { x: 0.5, y: 0.5 }, max_dimension: 800 } }) });
  for (const entries of [[c, r], [r]]) {
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline(entries), expandedIds: new Set(['call', 'result']) } });
    expect(wrapper.findAll('a, img, canvas, video')).toHaveLength(0);
    expect(wrapper.text()).toContain('Image snapshot recorded');
    expect(wrapper.text()).toContain('sha256');
    expect(wrapper.get('.tool-result .safe-original code').element.textContent).toBe(r.content);
    if (entries.length === 2) expect(wrapper.get('.tool-request .safe-original code').element.textContent).toBe(c.content);
    else expect(wrapper.text()).toContain('Requested context unavailable');
    expect(wrapper.html()).not.toMatch(/data:image|base64|images\/|model received|model saw/);
  }
});

it('preserves producer-neutral typed descriptors without requiring workspace data or promoting nested image-like values', () => {
  const descriptor = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 2, height: 1, byte_length: 20, sha256: 'a'.repeat(64) };
  const generic = presentToolResult(JSON.stringify({ success: true, content: [{ type: 'image', image: descriptor }], data: { opaque: true } }), { tool: 'custom_probe' });
  expect(generic.sections.find(section => section.title.startsWith('Typed image descriptor'))?.content).toBe(JSON.stringify(descriptor, null, 2));
  expect(JSON.stringify(generic)).not.toContain('Image snapshot recorded');
  const opaque = presentToolResult(JSON.stringify({ success: true, data: { image: descriptor, image_url: 'opaque-value' } }), { tool: 'mcp_tool_call' });
  expect(opaque.sections.some(section => section.title.startsWith('Typed image descriptor'))).toBe(false);
});

it('abbreviates long image paths as text while preserving exact path, descriptor and both safe originals', () => {
  const path = `work:///tmp/${'image-observations/'.repeat(200)}FINAL-SNAPSHOT.png`;
  const c = call('view_image', { path, max_dimension: 800 });
  const descriptor = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 800, height: 400, byte_length: 1000, sha256: 'a'.repeat(64) };
  const r = result('view_image', {}, { content: JSON.stringify({ success: true, content: [{ type: 'image', image: descriptor }], data: { source_path: path, sent_dimensions: { width: 800, height: 400 } } }) });
  const display = buildToolDisplay({ entry: c, mate: r });
  expect(inlinePartsText(display.target).length).toBeLessThanOrEqual(48);
  expect(inlinePartsText(display.target)).toContain('FINAL-SNAPSHOT.png');
  expect(display.links).toEqual([]);
  expect(inlinePartsText(display.status)).toBe('Image snapshot recorded · sent 800 × 400');
  const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([c, r]), expandedIds: new Set(['call']) } });
  expect(wrapper.findAll('a, img, canvas, video')).toHaveLength(0);
  expect(wrapper.get('.tool-request .semantic-section').text()).toContain(path);
  expect(wrapper.get('.tool-result .semantic-section').text()).toContain(path);
  expect(wrapper.get('.tool-request .safe-original code').element.textContent).toBe(c.content);
  expect(wrapper.get('.tool-result .safe-original code').element.textContent).toBe(r.content);
  expect(wrapper.text()).toContain(descriptor.sha256);
});

it('presents ordered native MCP content and two metadata-only descriptors once within the paired Result', () => {
  const descriptor = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 2, height: 1, byte_length: 20, sha256: 'a'.repeat(64) };
  const blocks = [{ type: 'text', text: 'native before' }, { type: 'image', image: descriptor }, { type: 'text', text: '{"native":"plain text"}' }, { type: 'image', image: { ...descriptor, id: '00000000-0000-4000-8000-000000000002' } }, { type: 'text', text: 'native after' }];
  const raw = JSON.stringify({ success: true, data: { result: { structuredContent: { count: 2 } } }, content: blocks });
  const c = call('mcp_tool_call', { serverName: 'browser', toolName: 'browser_take_screenshot', args: {} });
  const r = result('mcp_tool_call', {}, { content: raw });
  const view = presentToolResult(raw, { tool: 'mcp_tool_call' });
  expect(view.sections[0].title).toBe('MCP envelope metadata (effects opaque)');
  expect(view.sections.slice(1).map(section => [section.language, section.title])).toEqual([
    ['text', 'Returned text · content 1'], ['json', 'Typed image descriptor (metadata only) · content 2'],
    ['text', 'Returned text · content 3'], ['json', 'Typed image descriptor (metadata only) · content 4'],
    ['text', 'Returned text · content 5'],
  ]);
  const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([c, r]), expandedIds: new Set(['call']) } });
  expect(wrapper.findAll('[data-tool-entry-id]')).toHaveLength(1);
  expect(wrapper.findAll('[data-entry-id="call"]')).toHaveLength(1);
  expect(wrapper.findAll('[data-entry-id="result"]')).toHaveLength(1);
  const sections = wrapper.findAll('.tool-result .semantic-section');
  expect(sections.map(section => section.text()).join('|')).toMatch(/native before.*content 2.*plain text.*content 4.*native after/s);
  expect(wrapper.get('.tool-result .safe-original code').element.textContent).toBe(raw);
  expect(wrapper.findAll('a, img, canvas, video')).toHaveLength(0);
  expect(wrapper.html()).not.toMatch(/data:image|base64|Image snapshot recorded/);
  expect(inlinePartsText(buildToolDisplay({ entry: c, mate: r }).status)).toBe('Observation recorded · Effects opaque');
});
