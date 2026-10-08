import { expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';
import { mount } from '@vue/test-utils';
import ConversationTimeline from '../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline } from '../utils/agent-timeline';
import { call, result } from './tool-presenters/fixtures';

it('renders/copies only recorded image metadata without asserting delivery or linking source pixels', () => {
  const raw = JSON.stringify({ success: true, image: { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 1600, height: 800, byte_length: 1000, sha256: 'a'.repeat(64) }, data: { source_path: 'screen.png', source_dimensions: { width: 2048, height: 1024 }, oriented_dimensions: { width: 2048, height: 1024 }, sent_dimensions: { width: 1600, height: 800 }, orientation_applied: false, resized: true, scale: { x: 0.78125, y: 0.78125 }, max_dimension: 1600 } });
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
  expect(presentToolResult('{"success":false,"error":"Invalid PNG/JPEG"}', { tool: 'view_image' }).outcome).toBe('Failed');
});

it('keeps image paths plain text in both halves, including complete metadata-only RAW', () => {
  const c = call('view_image', { path: 'screen.png', max_dimension: 800 });
  const descriptor = { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 800, height: 400, byte_length: 1000, sha256: 'a'.repeat(64) };
  const r = result('view_image', {}, { content: JSON.stringify({ success: true, image: descriptor, data: { source_path: 'screen.png', source_dimensions: { width: 1600, height: 800 }, oriented_dimensions: { width: 1600, height: 800 }, sent_dimensions: { width: 800, height: 400 }, orientation_applied: false, resized: true, scale: { x: 0.5, y: 0.5 }, max_dimension: 800 } }) });
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
  const generic = presentToolResult(JSON.stringify({ success: true, image: descriptor, data: { opaque: true } }), { tool: 'custom_probe' });
  expect(generic.sections.find(section => section.title.startsWith('Typed image descriptor'))?.content).toBe(JSON.stringify(descriptor, null, 2));
  expect(JSON.stringify(generic)).not.toContain('Image snapshot recorded');
  const opaque = presentToolResult(JSON.stringify({ success: true, data: { image: descriptor, image_url: 'opaque-value' } }), { tool: 'mcp_tool_call' });
  expect(opaque.sections.some(section => section.title.startsWith('Typed image descriptor'))).toBe(false);
});
