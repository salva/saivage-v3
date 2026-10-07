import { expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';

it('renders/copies only recorded image metadata without asserting delivery or linking source pixels', () => {
  const raw = JSON.stringify({ success: true, image: { id: '00000000-0000-4000-8000-000000000001', mime_type: 'image/png', width: 1600, height: 800, byte_length: 1000, sha256: 'a'.repeat(64) }, data: { source_path: 'screen.png', source_dimensions: { width: 2048, height: 1024 }, oriented_dimensions: { width: 2048, height: 1024 }, sent_dimensions: { width: 1600, height: 800 }, orientation_applied: false, resized: true, scale: { x: 0.78125, y: 0.78125 }, max_dimension: 1600 } });
  const result = presentToolResult(raw, { tool: 'view_image' });
  expect(result.outcome).toBe('Image snapshot recorded');
  expect(result.headline).toEqual([{ kind: 'text', text: '1600 × 800' }]);
  const call = presentToolCall(JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'view_image', arguments: '{"path":"screen.png"}' } }] }));
  expect(call.headline.every(part => part.kind === 'text')).toBe(true);
  const copy = JSON.stringify({ call, result, raw });
  expect(copy).toContain('screen.png');
  expect(copy).not.toMatch(/data:image|base64|\/images\/|model saw|kind\\":\\"file/);
  expect(presentToolResult('{"success":false,"error":"Invalid PNG/JPEG"}', { tool: 'view_image' }).outcome).toBe('Failed');
});
