import { afterEach, expect, it } from '@jest/globals';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { normalizeImage, normalizeWorkspaceImage } from '../../src/tools/image-decode.js';
import { projectNativeMcpResult } from '../../src/tools/mcp-native-result.js';
import type { NativeMcpResult } from '../../src/mcp/tool-api.js';
import { materializeConversationImage } from '../../src/persistence/session-api.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(['png', 'jpeg', 'webp'] as const)('normalizes native %s with honest source/oriented/sent metadata and no fabricated path', async format => {
  const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-native-decode-'); roots.push(root);
  const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#abc' } }).toFormat(format).toBuffer();
  const result = await projectNativeMcpResult({ content: [{ type: 'text', text: 'before' }, { type: 'image', data: bytes.toString('base64'), mimeType: `image/${format}` }, { type: 'resource_link', uri: 'https://example.test/x', name: 'link' }, { type: 'text', text: 'after' }], structuredContent: { image: { type: 'image', data: 'ordinary' } } }, root, 'agent:analyst:global', new AbortController().signal, 8);
  expect(result).toMatchObject({ kind: 'succeeded', data: { images: [{ content_index: 1, source_dimensions: { width: 20, height: 10 }, oriented_dimensions: { width: 20, height: 10 }, sent_dimensions: { width: 8, height: 4 }, resized: true, scale: { x: 0.4, y: 0.4 }, max_dimension: 8 }] } });
  if (result.kind !== 'succeeded' || result.content?.[1]?.type !== 'image') throw new Error('Expected image result');
  expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'text', 'text']);
  expect(JSON.stringify(result.data)).not.toContain('source_path');
  const materialized = await materializeConversationImage(root, 'agent:analyst:global', result.content[1].image);
  const selected = Buffer.from(materialized.dataUrl.split(',')[1]!, 'base64');
  expect(await sharp(selected).metadata()).toMatchObject({ format: 'png', width: 8, height: 4, space: 'srgb' });
  if (format === 'webp') await expect(normalizeWorkspaceImage(bytes, 'source.webp')).rejects.toThrow('Unsupported decoded image format');
});
it('applies orientation before resize and preserves original override', async () => {
  const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#abc' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const selected = await normalizeImage(bytes, 'original', 'image/jpeg');
  expect(selected.data).toMatchObject({ source_dimensions: { width: 20, height: 10 }, oriented_dimensions: { width: 10, height: 20 }, sent_dimensions: { width: 10, height: 20 }, orientation_applied: true, resized: false, max_dimension: 'original' });
});
it.each(['png', 'jpeg'] as const)('selects identical neutral, workspace and MCP %s bytes/facts with real alpha or reflected pixels', async format => {
  const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-native-decode-'); roots.push(root);
  const width = 40, height = 20;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4 + (i % width < width / 2 ? 0 : 2)] = 255;
    pixels[i * 4 + 3] = format === 'png' ? 128 : 255;
  }
  const input = sharp(pixels, { raw: { width, height, channels: 4 } });
  const source = await (format === 'jpeg'
    ? input.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 2 })
    : input.png()).toBuffer();
  const neutral = await normalizeImage(source, 'original', `image/${format}`);
  const workspace = await normalizeWorkspaceImage(source, 'project:///source', 'original');
  const { source_path, ...workspaceFacts } = workspace.data;
  expect(source_path).toBe('project:///source');
  expect(workspaceFacts).toEqual(neutral.data);
  expect(workspace.bytes).toEqual(neutral.bytes);
  const result = await projectNativeMcpResult({ content: [{ type: 'image', data: source.toString('base64'), mimeType: `image/${format}` }] }, root, 'agent:analyst:global', new AbortController().signal, 'original');
  expect(result).toMatchObject({ kind: 'succeeded', data: { images: [{ content_index: 0, ...neutral.data }] } });
  if (result.kind !== 'succeeded' || result.content?.[0]?.type !== 'image') throw new Error('Expected image result');
  const materialized = await materializeConversationImage(root, 'agent:analyst:global', result.content[0].image);
  expect(Buffer.from(materialized.dataUrl.split(',')[1]!, 'base64')).toEqual(neutral.bytes);
  const { data, info } = await sharp(neutral.bytes).raw().toBuffer({ resolveWithObject: true });
  const left = (10 * width + 5) * info.channels;
  const right = (10 * width + 35) * info.channels;
  if (format === 'jpeg') {
    expect(neutral.data.orientation_applied).toBe(true);
    expect(data[left + 2]).toBeGreaterThan(240); expect(data[left]).toBeLessThan(15);
    expect(data[right]).toBeGreaterThan(240); expect(data[right + 2]).toBeLessThan(15);
  } else {
    expect(info.channels).toBe(4);
    expect(data[left]).toBe(255); expect(data[right + 2]).toBe(255);
    expect(data[left + 3]).toBe(128); expect(data[right + 3]).toBe(128);
  }
});
it('rejects mismatched MIME, malformed base64 and animation', async () => {
  const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#abc' } }).png().toBuffer();
  for (const block of [
    { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
    { type: 'image', data: 'YR==', mimeType: 'image/png' },
    { type: 'image', data: 'YQ', mimeType: 'image/png' },
    { type: 'image', data: 'YQ==\n', mimeType: 'image/png' },
    { type: 'image', data: 'YQ==', mimeType: 'image/gif' },
  ] satisfies NativeMcpResult['content']) await expect(projectNativeMcpResult({ content: [block] }, '/unused', 'agent:analyst:global', new AbortController().signal)).rejects.toThrow();
  const animationChunk = Buffer.alloc(12); animationChunk.write('acTL', 4, 'ascii');
  await expect(normalizeImage(Buffer.concat([bytes.subarray(0, 8), animationChunk, bytes.subarray(8)]), 1600, 'image/png')).rejects.toThrow('Animated images');
  await expect(normalizeImage(Buffer.alloc(32 * 1024 * 1024 + 1), 1600, 'image/png')).rejects.toThrow('32 MiB');
  const manyPixels = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#abc' } }).png().toBuffer();
  await expect(normalizeImage(manyPixels, 1600, 'image/png')).rejects.toThrow(/oversized|pixel/);
});
