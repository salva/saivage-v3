import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeWorkspaceImage } from '../../src/tools/image-decode.js';
import { readWorkspaceImageSource } from '../../src/tools/project-file-tools.js';
import { workspaceToolBinders, globalWorkspaceObservationToolBinders } from '../../src/tools/workspace-provider.js';
import { materializeConversationImage, publishConversationImage } from '../../src/persistence/session-api.js';
import { conversationImageFile } from '../../src/persistence/layout.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { MAX_IMAGE_SOURCE_BYTES, ToolResultSchema, assertViewImageResult, rasterReservation, imageAccountingBytes, imageEstimatedTokens, viewImageInputSchema } from '../../src/contracts/index.js';
import type { LlmToolInvocationContext } from '../../src/runtime/runtime-api.js';
import type { AgentName } from '../../src/schemas/index.js';
import type { CardService } from '../../src/cards/store-api.js';
import { isReadBlocked } from '../../src/workspace/index.js';

const roots: string[] = [];
function root() { const path = mkdtempSync('/home/salva/g/ml/tmp/saivage-image-test-'); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 12, g: 23, b: 34, alpha: 0.5 } } }).png().toBuffer();

describe('explicit immutable workspace image observations', () => {
  it.each([[2048, 1024, 1600, 800], [1024, 2048, 800, 1600], [2000, 20000, 160, 1600], [20, 10, 20, 10]])('normalizes %ix%i without upscaling or metadata', async (width, height, sentWidth, sentHeight) => {
    const source = await png(width, height);
    const selected = await normalizeWorkspaceImage(source, 'project:///screen.png');
    expect(selected.data.sent_dimensions).toEqual({ width: sentWidth, height: sentHeight });
    expect(selected.data.scale).toEqual({ x: sentWidth / width, y: sentHeight / height });
    const metadata = await sharp(selected.bytes).metadata();
    expect(metadata.hasAlpha).toBe(true);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect((await sharp(selected.bytes).raw().toBuffer())[3]).toBeGreaterThan(0);
    expect((await sharp(selected.bytes).raw().toBuffer())[3]).toBeLessThan(255);
  });

  it.each([6, 7])('orients rotated/reflected JPEG %i before resize', async (orientation) => {
    const source = await sharp({ create: { width: 120, height: 60, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation }).toBuffer();
    const selected = await normalizeWorkspaceImage(source, 'screen.jpg', 80);
    expect(selected.data).toMatchObject({ source_dimensions: { width: 120, height: 60 }, oriented_dimensions: { width: 60, height: 120 }, sent_dimensions: { width: 40, height: 80 }, orientation_applied: true, resized: true });
    expect((await sharp(selected.bytes).metadata()).orientation).toBeUndefined();
  });

  it('uses original/integer overrides and refuses animation, invalid inputs and hard caps once', async () => {
    const source = await png(2000, 1000);
    expect((await normalizeWorkspaceImage(source, 'screen.png', 'original')).data.resized).toBe(false);
    expect((await normalizeWorkspaceImage(source, 'screen.png', 100)).data.sent_dimensions).toEqual({ width: 100, height: 50 });
    const animation = Buffer.concat([source.subarray(0, 8), Buffer.from([0,0,0,8]), Buffer.from('acTL'), Buffer.alloc(12), source.subarray(8)]);
    await expect(normalizeWorkspaceImage(animation, 'animated.png')).rejects.toThrow(/Animated/);
    await expect(normalizeWorkspaceImage(Buffer.from('not pixels'), 'fake.png')).rejects.toThrow(/Invalid/);
    await expect(normalizeWorkspaceImage(source.subarray(0, 40), 'truncated.png')).rejects.toThrow();
    await expect(normalizeWorkspaceImage(Buffer.alloc(MAX_IMAGE_SOURCE_BYTES + 1), 'huge.png')).rejects.toThrow(/32 MiB/);
    expect(viewImageInputSchema.safeParse({ path: 'x', max_dimension: 16385 }).success).toBe(false);
  });

  it('preserves the actual EXIF reflection rather than merely reporting oriented dimensions', async () => {
    const width = 120, height = 60;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255;
    const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 2 }).toBuffer();
    const selected = await normalizeWorkspaceImage(source, 'reflected.jpg', 'original');
    expect(selected.data).toMatchObject({ orientation_applied: true, resized: false, sent_dimensions: { width, height } });
    const { data, info } = await sharp(selected.bytes).raw().toBuffer({ resolveWithObject: true });
    const left = (30 * width + 20) * info.channels;
    const right = (30 * width + 100) * info.channels;
    expect(data[left + 2]).toBeGreaterThan(240);
    expect(data[left]).toBeLessThan(15);
    expect(data[right]).toBeGreaterThan(240);
    expect(data[right + 2]).toBeLessThan(15);
  });

  it('enforces decoded pixel and selected-PNG caps without relaxing original or retrying conversion', async () => {
    const oversized = await png(4000, 10001);
    await expect(normalizeWorkspaceImage(oversized, 'too-many-pixels.png')).rejects.toThrow(/pixel|oversized/i);
    const pixels = Buffer.alloc(3000 * 2000 * 3);
    let seed = 0x12345678;
    for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255; }
    const source = await sharp(pixels, { raw: { width: 3000, height: 2000, channels: 3 } }).png().toBuffer();
    expect(source.length).toBeGreaterThan(16 * 1024 * 1024);
    expect(source.length).toBeLessThan(MAX_IMAGE_SOURCE_BYTES);
    await expect(normalizeWorkspaceImage(source, 'noise.png', 'original')).rejects.toThrow(/Selected PNG exceeds 16 MiB/);
    expect((await normalizeWorkspaceImage(source, 'noise.png', 100)).data.sent_dimensions).toEqual({ width: 100, height: 67 });
  }, 30_000);

  it('converts a synthetic screenshot with small labels and lines without claiming text readability', async () => {
    const background = await png(2048, 1024);
    const source = await sharp(background).composite([{ input: Buffer.from('<svg width="2048" height="1024"><path d="M20 20H2000 M20 40H2000" stroke="black" stroke-width="2"/><text x="24" y="80" font-size="12">synthetic label 012345</text></svg>') }]).png().toBuffer();
    const before = Buffer.from(source);
    const selected = await normalizeWorkspaceImage(source, 'labelled.png');
    expect(source).toEqual(before);
    expect(selected.data.sent_dimensions).toEqual({ width: 1600, height: 800 });
    const { data, info } = await sharp(selected.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray((16 * info.width + 40) * info.channels, (16 * info.width + 40) * info.channels + 3)]).not.toEqual([12, 23, 34]);
  });

  it('admits exact project/work/own tmp, blocks secret/internal/alias/outside and directories', async () => {
    const projectRoot = root();
    const outside = root();
    const bytes = await png(10, 10);
    const ctx = { projectRoot, cardId: 'project', agentName: 'executor' as AgentName };
    for (const path of ['screen.png', '.saivage/work/screen.png', '.saivage/work/cards/project/tmp/screen.png']) {
      mkdirSync(join(projectRoot, path, '..'), { recursive: true }); writeFileSync(join(projectRoot, path), bytes);
    }
    for (const path of ['screen.png', 'project:///screen.png', 'work:///screen.png', 'tmp:///project/screen.png'])
      expect(readWorkspaceImageSource(ctx, path, MAX_IMAGE_SOURCE_BYTES).bytes).toEqual(bytes);
    writeFileSync(join(projectRoot, '.env'), bytes);
    writeFileSync(join(outside, 'screen.png'), bytes);
    symlinkSync(join(outside, 'screen.png'), join(projectRoot, 'outside.png'));
    symlinkSync(join(projectRoot, '.env'), join(projectRoot, 'secret.png'));
    mkdirSync(join(projectRoot, '.saivage/repair-attic'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage/repair-attic/screen.png'), bytes);
    symlinkSync(join(projectRoot, '.saivage/repair-attic/screen.png'), join(projectRoot, 'attic-alias.png'));
    for (const path of ['.env', '.saivage/work/screen.png', '.saivage/repair-attic/screen.png', 'attic-alias.png', 'secret.png', 'outside.png', '.', 'system:///screen.png', 'record:///screen.png', 'tmp:///card-a/screen.png'])
      expect(() => readWorkspaceImageSource(ctx, path, MAX_IMAGE_SOURCE_BYTES)).toThrow();
  });

  it.each(['agent:executor:project', 'agent:analyst:global'] as const)('publishes under exact %s owner, retains pixels after source deletion, and fails strict selected use', async (sessionId) => {
    const projectRoot = root();
    const source = await png(30, 20); writeFileSync(join(projectRoot, 'screen.png'), source);
    const binder = (sessionId === 'agent:analyst:global' ? globalWorkspaceObservationToolBinders : workspaceToolBinders).find((tool) => tool.name === 'view_image')!;
    const tool = binder.bind({ projectRoot, cardId: 'project', agentName: 'executor' as AgentName, store: {} as CardService });
    const execution = await tool.executor({ path: 'screen.png' }, new AbortController().signal, { sessionId } as unknown as LlmToolInvocationContext);
    const result = settleToolActionOutcome(execution.providerOutcome).providerResult;
    expect(result.success).toBe(true);
    if (!result.success || result.content?.[0]?.type !== 'image') throw new Error('expected snapshot');
    const image = result.content[0].image;
    expect(readFileSync(join(projectRoot, 'screen.png'))).toEqual(source);
    unlinkSync(join(projectRoot, 'screen.png'));
    const path = conversationImageFile(projectRoot, sessionId, image.id);
    const imageRoot = join(path, '..');
    expect(readdirSync(imageRoot)).toEqual([`${image.id}.png`]);
    const materialized = await materializeConversationImage(projectRoot, sessionId, image);
    expect(Buffer.from(materialized.dataUrl.split(',')[1]!, 'base64')).toEqual(readFileSync(path));
    writeFileSync(join(imageRoot, 'unselected.png'), 'untouched');
    writeFileSync(path, 'corrupt');
    await expect(materializeConversationImage(projectRoot, sessionId, image)).rejects.toThrow(/length\/hash/);
    expect(readFileSync(join(imageRoot, 'unselected.png'), 'utf8')).toBe('untouched');
    unlinkSync(path);
    await expect(materializeConversationImage(projectRoot, sessionId, image)).rejects.toThrow(/ENOENT/);
    expect(isReadBlocked('.saivage/agents/conversations/analyst/images')).toBe(true);
    expect(isReadBlocked('.saivage/cards/project/children/a/conversations/executor/images/x.png')).toBe(true);
  });

  it('keeps image-free failures and refuses missing invocation authority', async () => {
    const projectRoot = root(); writeFileSync(join(projectRoot, 'bad.png'), 'not pixels');
    const tool = workspaceToolBinders.find((tool) => tool.name === 'view_image')!.bind({ projectRoot, agentName: 'executor' as AgentName });
    await expect(tool.executor({ path: 'bad.png' }, new AbortController().signal)).rejects.toThrow(/complete owning/);
    const execution = await tool.executor({ path: 'bad.png' }, new AbortController().signal, { sessionId: 'agent:executor:project' } as unknown as LlmToolInvocationContext);
    expect(settleToolActionOutcome(execution.providerOutcome).providerResult).toMatchObject({ success: false });
    expect(settleToolActionOutcome(execution.providerOutcome).providerResult).not.toHaveProperty('content');
  });

  it('strictly validates result metadata and uses the fixed raster accounting heuristic', async () => {
    const projectRoot = root();
    const selected = await normalizeWorkspaceImage(await png(10, 10), 'screen.png');
    const image = publishConversationImage(projectRoot, 'agent:analyst:global', selected.bytes, selected.data.sent_dimensions);
    expect(ToolResultSchema.safeParse({ success: false, error: 'failed', content: [{ type: 'image', image }] }).success).toBe(false);
    expect(() => assertViewImageResult({ ...selected.data, sent_dimensions: { width: 20, height: 10 } }, image)).toThrow();
    expect(rasterReservation({ width: 1024, height: 1024 })).toBe(2048);
    expect(rasterReservation({ width: 1600, height: 1600 })).toBe(5000);
    expect(rasterReservation({ width: 2048, height: 2048 })).toBe(8192);
    expect(rasterReservation({ width: 33, height: 1 })).toBe(4);
    expect(imageAccountingBytes(image)).toBeGreaterThan(image.byte_length);
    expect(imageEstimatedTokens(image)).toBeGreaterThan(rasterReservation(image));
  });
});
