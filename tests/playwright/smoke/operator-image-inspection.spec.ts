import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import type { App } from '../../../src/boot/app.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/config/system-templates/registry.js';
import { createResolvedConfigAuthority } from '../../../src/config/index.js';
import { CardService } from '../../../src/cards/card-service.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { materializeConversationImage } from '../../../src/persistence/session-api.js';
import { conversationImageFile } from '../../../src/persistence/layout.js';
import { globalWorkspaceObservationToolBinders } from '../../../src/tools/workspace-provider.js';
import { projectNativeMcpResult } from '../../../src/tools/mcp-native-result.js';
import { settleToolActionOutcome } from '../../../src/tools/tool-result-settlement.js';
import { agentMessageSchema, STRUCTURAL_ROW_POLICY, type ConversationSessionId } from '../../../src/schemas/index.js';
import type { ToolResult } from '../../../src/contracts/tool-result.js';
import type { ImageDescriptor } from '../../../src/contracts/image.js';
import { compact, prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import { noCompactionProgress } from '../../helpers/executing-llm-snapshot.js';
import { productionTestConfig, writeProductionConfig, initializeProject, startProductionApp, appOrigin, listen, closeServer } from '../../helpers/production-composition-e2e.js';
import { testLlmToolInvocationContext } from '../../helpers/llm-test-helpers.js';
import { toolRowPolicies, TEXT_ROW_POLICY } from '../../helpers/row-policy-fixtures.js';

// Real production HTTP/auth/WS/static server, actual producers and current-format
// persistence. No route mocks, live installation or provider/tool continuation.
test.describe.configure({ timeout: 180_000, retries: 0 });
const token = 'synthetic-image-browser-token';
let sessions: readonly ConversationSessionId[];
const timestamp = '2026-10-08T00:00:00.000Z';
const evidence = join(process.cwd(), 'docs/working/2026-10-09-fix-f04-tool-pairing/evidence/browser');
let root: string, app: App, origin: string, cards: CardService;
let providerCalls = 0;
const sink = createServer((_req, res) => { providerCalls++; res.writeHead(500); res.end('Forbidden synthetic provider invocation'); });
const report: object[] = [];
const selected = new Map<string, { descriptor: ImageDescriptor; requestId: string; messageId: string; segmentId: string; version: number }[]>();
const failedRequests = new Map<string, string>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function append(session: ConversationSessionId, tool: string, result: ToolResult, name: string, label = name) {
  const input = randomUUID(), content = JSON.stringify(result), policies = toolRowPolicies({ content });
  let index = 0;
  const row = (id: string, role: 'system' | 'assistant' | 'tool', content: string) => ({ id, session_id: session, role, content, timestamp, round_id: `r-assistant-${input.replaceAll('-', '')}`, message_index: index++, block_index: 0 });
  const messageId = `${input}:tool-result:${name}`;
  const requestId = `${input}:tool-call:${name}`;
  appendConversationBatch({ projectRoot: root }, [
    { ...row(`${input}:activation`, 'system', JSON.stringify({ event: 'activation_open', agent_name: session.split(':')[1], ...(session.endsWith(':global') ? {} : { card_id: session.split(':')[2] }), input_id: input, timestamp })), kind: 'activity', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary },
    { ...row(requestId, 'assistant', JSON.stringify({ role: 'assistant', tool_calls: [{ id: name, type: 'function', function: { name: tool, arguments: JSON.stringify({ path: label }) } }] })), kind: 'tool_call', tool, tool_call_id: name, context_policy: policies.call },
    ...(label.endsWith('current') ? [{ ...row(`${input}:between`, 'assistant', 'Intervening public prose, before the result was known.'), kind: 'text', context_policy: TEXT_ROW_POLICY }] : []),
    { ...row(messageId, 'tool', content), kind: 'tool_result', tool, tool_call_id: name, context_policy: policies.result },
    { ...row(`${input}:tail`, 'assistant', 'Reading-position line\n'.repeat(200)), kind: 'text', context_policy: TEXT_ROW_POLICY },
  ].map(value => agentMessageSchema.parse(value)));
  const segment = readCurrentConversationSegment(root, session)!;
  return { requestId, messageId, segmentId: segment.entry.entry_id, version: segment.entry.version };
}
async function seed(session: ConversationSessionId, suffix: string) {
  const execution = await globalWorkspaceObservationToolBinders.find(b => b.name === 'view_image')!.bind({ projectRoot: root, agentName: 'analyst', store: cards }).executor({ path: 'source.png' }, new AbortController().signal, testLlmToolInvocationContext({ sessionId: session, toolName: 'view_image' }));
  const result = settleToolActionOutcome(execution.providerOutcome).providerResult;
  if (!result.success || result.content?.[0]?.type !== 'image') throw new Error('Missing actual view_image pixels');
  const locator = append(session, 'view_image', result, 'call_0', `view-${suffix}`);
  const small = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const native = settleToolActionOutcome(await projectNativeMcpResult({ content: [{ type: 'text', text: 'native-before' }, { type: 'image', data: small.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'native-between' }, { type: 'image', data: blue.toString('base64'), mimeType: 'image/png' }] }, root, session, new AbortController().signal)).providerResult;
  if (!native.success) throw new Error('Missing actual native MCP result');
  const nativeLocator = append(session, 'mcp_tool_call', native, 'call_0', `native-${suffix}`);
  failedRequests.set(`${session}:${suffix}`, append(session, 'view_image', { success: false, error: `Distinct failed ${suffix} snapshot` }, 'call_0', `failed-${suffix}`).requestId);
  selected.set(`${session}:${suffix}`, [{ descriptor: result.content[0].image, ...locator }, ...native.content!.flatMap(block => block.type === 'image' ? [{ descriptor: block.image, ...nativeLocator }] : [])]);
}
async function advance(session: ConversationSessionId) {
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: .8, trigger_fraction: .8, tail_fraction: 0, snap: 'compact_straddler' }, 'system', [], 8000, 2000);
  const candidate = { provider: 'test', account: null, model: 'test' } as const;
  const outcome = await compact({ strategy: 'local_exact_admission', conversations: { projectRoot: root }, input: {
    inputId: randomUUID(), agentId: session, agentName: session.split(':')[1]!, sessionId: session, systemPrompt: 'system', providerConversation: providerConversationProjection(readCurrentConversationSegment(root, session)!.conversation, []), tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [candidate] }, episodeContext: {},
  }, summarizerProvider: { candidate, contextWindowTokens: 100000, maxOutputTokens: 10000, materializeImage: (source, descriptor) => materializeConversationImage(root, source, descriptor), serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message', content: 'Synthetic covered history; no delivery proof.' }, provider_exchanges: [] }), projectProviderExchanges: () => [] }, signal: new AbortController().signal, progress: noCompactionProgress });
  expect(outcome.kind).toBe('compacted');
}
test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  const port = await listen(sink);
  root = mkdtempSync('/home/salva/g/ml/tmp/image-browser-');
  writeProductionConfig(root, productionTestConfig(port, config => {
    for (const [name, agent] of Object.entries(config.agents)) agent.tools = [...DEFAULT_SAIVAGE_CONFIG.agents[name]!.tools];
    config.providers.fixture!.capabilities = { ...config.providers.fixture!.capabilities, transportProtocol: 'openai-responses', imageInput: true };
    config.oversight.enabled = false; config.mcpServers = {};
  }));
  initializeProject(root);
  const workflows = createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: {} }).loadEffective().workflows;
  cards = new CardService(root, workflows);
  const child = cards.create({ type: 'code', parent: 'project', title: 'Synthetic image inspection', bootstrap_content: 'Non-secret synthetic screenshots', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  sessions = [`agent:executor:${child.id}` as ConversationSessionId, 'agent:analyst:global'];
  // Distinct halves/checkers survive normalization and support exact pixel samples.
  const tile = await sharp({ create: { width: 2400, height: 3600, channels: 3, background: '#ff0000' } }).composite([{ input: await sharp({ create: { width: 1200, height: 3600, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 1200, top: 0 }]).png().toBuffer();
  writeFileSync(join(root, 'source.png'), tile);
  for (const session of sessions) { await seed(session, 'history'); await advance(session); await seed(session, 'current'); }
  mkdirSync(join(root, '.saivage/work'), { recursive: true }); writeFileSync(join(root, '.saivage/work/current.png'), tile);
  mkdirSync(join(root, '.saivage/repair-attic'), { recursive: true }); writeFileSync(join(root, '.saivage/repair-attic/canary.png'), tile);
  symlinkSync(join(root, '.saivage/repair-attic/canary.png'), join(root, '.saivage/work/attic-alias.png'));
  // Synthetic forbidden canary; no real credential content is inspected.
  mkdirSync(evidence, { recursive: true });
  app = await startProductionApp(root, token); origin = appOrigin(app);
  writeFileSync(join(root, '.saivage/auth-profiles.json'), tile);
});
test.afterAll(async () => {
  try { if (app) await app.stop(); } finally { await closeServer(sink); if (root) rmSync(root, { recursive: true, force: true }); writeFileSync(join(evidence, 'report.json'), JSON.stringify({ providerCalls, checks: report }, null, 2)); }
  expect(providerCalls).toBe(0);
});
async function pixels(dialog: Locator, descriptor: Pick<ImageDescriptor, 'width' | 'height' | 'sha256'>) {
  const img = dialog.locator('img'); await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(descriptor.width);
  const measured = await img.evaluate(async (el: HTMLImageElement) => { const canvas = document.createElement('canvas'); canvas.width = el.naturalWidth; canvas.height = el.naturalHeight; const ctx = canvas.getContext('2d')!; ctx.drawImage(el, 0, 0); const bytes = await (await fetch(el.src)).arrayBuffer(); const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''); return { sha256, width: el.naturalWidth, height: el.naturalHeight, left: [...ctx.getImageData(1, 1, 1, 1).data], right: [...ctx.getImageData(el.naturalWidth - 2, 1, 1, 1).data] }; });
  expect(measured.height).toBe(descriptor.height); expect(measured.sha256).toBe(descriptor.sha256); report.push({ pixels: measured, sha256: descriptor.sha256 });
  return measured;
}
function assertImageUrl(url: string, session: ConversationSessionId, fixture: { descriptor: ImageDescriptor; messageId: string; segmentId: string; version: number }, contentIndex: number) {
  const parsed = new URL(url);
  expect(decodeURIComponent(parsed.pathname)).toContain(session);
  expect(Object.fromEntries(parsed.searchParams)).toEqual({ segment_id: fixture.segmentId, segment_version: String(fixture.version), message_id: fixture.messageId, content_index: String(contentIndex), image_id: fixture.descriptor.id });
  report.push({ session, exactImage: Object.fromEntries(parsed.searchParams) });
}
async function geometry(page: Page, name: string) {
  const dialog = page.getByRole('dialog'), image = dialog.locator('img'), area = dialog.getByLabel('Image viewport');
  for (const mode of ['Fit', '1:1']) {
    await dialog.getByRole('button', { name: mode, exact: true }).click();
    const g = await area.evaluate(el => { const image = el.querySelector('img')!; return { vw: el.clientWidth, vh: el.clientHeight, iw: image.getBoundingClientRect().width, ih: image.getBoundingClientRect().height, nw: image.naturalWidth, nh: image.naturalHeight }; });
    if (mode === 'Fit') { expect(g.iw).toBeLessThanOrEqual(Math.min(g.nw, g.vw) + 1); expect(g.ih).toBeLessThanOrEqual(Math.min(g.nh, g.vh) + 1); }
    else { expect(g.iw).toBe(g.nw); expect(g.ih).toBe(g.nh); await area.focus(); await page.keyboard.press('PageDown'); if (g.nh > g.vh) await expect.poll(() => area.evaluate(el => el.scrollTop)).toBeGreaterThan(0); await page.keyboard.press('ArrowRight'); if (g.nw > g.vw) await expect.poll(() => area.evaluate(el => el.scrollLeft)).toBeGreaterThan(0); await area.evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; }); const scroll = await area.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop })); if (g.nw > g.vw) expect(scroll.x).toBeGreaterThan(0); if (g.nh > g.vh) expect(scroll.y).toBeGreaterThan(0); await area.evaluate(el => { el.scrollLeft = el.scrollTop = 0; }); }
    report.push({ geometry: name, mode, ...g }); await page.screenshot({ path: join(evidence, `${name}-${mode.replace(':', '-')}.png`) });
  }
  expect(await image.count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await dialog.getByRole('button').all()) { const bounds = (await button.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual((await page.viewportSize())!.width); }
}

test('real local pixels/auth/history/Files/keyboard/return evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(value => localStorage.setItem('saivage_api_token', value), token);
  const imageUrls: string[] = []; page.on('request', req => { if (req.url().includes('/images?') || req.url().includes('/files/image?')) imageUrls.push(req.url()); });
  for (const session of sessions) {
    for (const suffix of ['current', 'history']) {
      const fixtures = selected.get(`${session}:${suffix}`)!;
      const selectionQuery = suffix === 'history' ? `segment=${fixtures[0].version}&` : '';
      await page.goto(`${origin}/agents/${encodeURIComponent(session)}?${selectionQuery}entry=${encodeURIComponent(fixtures[0].messageId)}`);
      const reader = page.locator('.conv-rounds');
      await expect(reader.locator('.targeted-conversation-entry')).toHaveAttribute('data-entry-id', fixtures[0].messageId);
      const viewChip = reader.locator(`[data-tool-entry-id="${fixtures[0].requestId}"]`);
      const nativeChip = reader.locator(`[data-tool-entry-id="${fixtures[1].requestId}"]`);
      await nativeChip.locator('.tool-chip-toggle').click();
      for (const fixture of fixtures.slice(0, 2)) {
        await expect(reader.locator(`[data-entry-id="${fixture.requestId}"]`)).toHaveCount(1);
        await expect(reader.locator(`[data-entry-id="${fixture.messageId}"]`)).toHaveCount(1);
      }
      await expect(viewChip.locator('.tool-request')).toContainText(`view-${suffix}`);
      await expect(viewChip.locator('.tool-chip-status')).toContainText('Image snapshot recorded');
      await expect(viewChip.locator('.tool-result')).not.toContainText('native-before');
      await expect(nativeChip.locator('.tool-request')).toContainText(`native-${suffix}`);
      await expect(nativeChip.locator('.tool-result')).toContainText('native-before');
      const failed = reader.locator(`[data-tool-entry-id="${failedRequests.get(`${session}:${suffix}`)}"]`);
      await expect(failed.locator('.tool-chip-status')).toContainText(`Distinct failed ${suffix} snapshot`);
      await expect(failed.locator('.image-actions button')).toHaveCount(0);
      report.push({ session, selection: suffix, repeatedCallId: 'call_0', uniqueAnchors: fixtures.slice(0, 2).flatMap(f => [f.requestId, f.messageId]), targetedResult: fixtures[0].messageId, independentFailedRequest: failedRequests.get(`${session}:${suffix}`) });
      const action = viewChip.locator('.image-actions button');
      await expect(action).toBeVisible(); await action.focus(); const before = await reader.evaluate(el => el.scrollTop);
      await page.keyboard.press('Enter'); const dialog = page.getByRole('dialog');
      if (suffix === 'current') {
        const position = await reader.evaluate(el => el.scrollTop);
        const arrival = append(session, 'synthetic_arrival', { success: true, data: 'Fresh authoritative arrival' }, 'arrival');
        // A valid server-origin advisory exercises real websocket → REST refresh;
        // no browser route is mocked and no provider continuation is launched.
        for (const socket of app.server.fastify.websocketServer.clients) socket.send(JSON.stringify({ t: 'invalidate', resource: 'conversation', id: session, segment_version: arrival.version, segment_id: arrival.segmentId, visible_message_id: arrival.messageId }));
        await expect(reader.locator('[data-tool-entry-id$="tool-call:arrival"]')).toHaveCount(1);
        expect(await reader.evaluate(el => el.scrollTop)).toBe(position);
        report.push({ session, arrivalWhileInspecting: true, scroll: position });
      }
      expect((await pixels(dialog, fixtures[0].descriptor)).left).toEqual([255, 0, 0, 255]);
      const exactUrl = imageUrls.at(-1)!;
      assertImageUrl(exactUrl, session, fixtures[0], 0);
      const fetched = await page.request.get(exactUrl, { headers: { authorization: `Bearer ${token}` } });
      expect(hash(await fetched.body())).toBe(fixtures[0].descriptor.sha256);
      expect(fetched.headers()['cache-control']).toBe('no-store');
      for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await geometry(page, `${session.split(':')[1]}-${suffix}-${width}`); }
      await page.setViewportSize({ width: 1440, height: 900 });
      // Replace/delete mutable source. Refresh must still return the same selected bytes.
      writeFileSync(join(root, 'source.png'), await sharp({ create: { width: 5, height: 4, channels: 3, background: '#00ff00' } }).png().toBuffer()); unlinkSync(join(root, 'source.png'));
      await dialog.getByRole('button', { name: 'Refresh image' }).click(); expect((await pixels(dialog, fixtures[0].descriptor)).left).toEqual([255, 0, 0, 255]);
      await dialog.getByLabel('Image viewport').focus(); await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Fit', exact: true })).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(dialog.getByLabel('Image viewport')).toBeFocused();
      await dialog.getByRole('button', { name: '1:1', exact: true }).focus(); await page.keyboard.press('Space'); await expect(dialog.getByRole('button', { name: '1:1', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(action).toBeFocused(); expect(await reader.evaluate(el => el.scrollTop)).toBe(before);
      const nativeAction = nativeChip.locator('.image-actions button').first(); await nativeAction.click();
      expect((await pixels(page.getByRole('dialog'), fixtures[1].descriptor)).left).toEqual([0, 255, 0, 255]);
      assertImageUrl(imageUrls.at(-1)!, session, fixtures[1], 1);
      await page.getByRole('dialog').getByRole('button', { name: 'Fit', exact: true }).click(); const small = await page.getByRole('dialog').locator('img').boundingBox(); expect(small!.width).toBe(12);
      await expect(page.getByRole('button', { name: 'Previous image' })).toBeDisabled(); await page.getByRole('button', { name: 'Next image' }).click();
      expect((await pixels(page.getByRole('dialog'), fixtures[2].descriptor)).left).toEqual([0, 0, 255, 255]); await expect(page.getByRole('button', { name: 'Next image' })).toBeDisabled(); await page.getByRole('button', { name: 'Previous image' }).click(); await pixels(page.getByRole('dialog'), fixtures[1].descriptor);
      await page.evaluate(() => localStorage.removeItem('saivage_api_token')); await page.getByRole('button', { name: 'Refresh image' }).click(); await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Unauthorized'); await expect(page.getByRole('dialog').locator('img')).toHaveCount(0); await page.keyboard.press('Escape'); await page.evaluate(value => localStorage.setItem('saivage_api_token', value), token);
    }
  }
  // Actual shared Analyst panel caller, not just the global session route.
  await page.goto(`${origin}/cards/project`);
  const chat = page.locator('#analyst-chat-panel');
  const analystFixtures = selected.get(`${sessions[1]}:current`)!;
  for (const [index, contentIndex, color] of [[0, 0, [255, 0, 0, 255]], [1, 1, [0, 255, 0, 255]]] as const) {
    const fixture = analystFixtures[index];
    const chip = chat.locator(`[data-tool-entry-id="${fixture.requestId}"]`);
    await expect(chip).toBeVisible(); await chip.locator('.tool-chip-toggle').click();
    await expect(chat.locator(`[data-entry-id="${fixture.requestId}"]`)).toHaveCount(1);
    await expect(chat.locator(`[data-entry-id="${fixture.messageId}"]`)).toHaveCount(1);
    await expect(chip.locator('.tool-request')).toContainText(index === 0 ? 'view-current' : 'native-current');
    const chatImage = chip.locator('.image-actions button').first(); await chatImage.click();
    expect((await pixels(page.getByRole('dialog'), fixture.descriptor)).left).toEqual(color);
    assertImageUrl(imageUrls.at(-1)!, sessions[1], fixture, contentIndex);
    await geometry(page, `analyst-repeated-${index}`);
    await page.keyboard.press('Escape'); await expect(chatImage).toBeFocused();
  }
  const analystFailure = chat.locator(`[data-tool-entry-id="${failedRequests.get(`${sessions[1]}:current`)}"]`);
  await expect(analystFailure.locator('.tool-chip-status')).toContainText('Distinct failed current snapshot');
  await expect(analystFailure.locator('.image-actions button')).toHaveCount(0);
  report.push({ caller: 'AnalystChatPanel', repeatedCallId: 'call_0', uniqueAnchors: analystFixtures.slice(0, 2).flatMap(f => [f.requestId, f.messageId]), independentFailedRequest: failedRequests.get(`${sessions[1]}:current`) });
  await page.goto(`${origin}/files?root=output&path=.saivage/work/current.png`);
  await page.getByRole('button', { name: 'Inspect image · Current source' }).click(); await expect(page.getByRole('dialog')).toContainText('Decoded 2400 × 3600');
  await pixels(page.getByRole('dialog'), { width: 2400, height: 3600, sha256: hash(readFileSync(join(root, '.saivage/work/current.png'))) });
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await geometry(page, `files-current-${width}`); }
  await page.setViewportSize({ width: 1440, height: 900 });
  writeFileSync(join(root, '.saivage/work/current.png'), await sharp({ create: { width: 7, height: 9, channels: 3, background: '#00ff00' } }).png().toBuffer()); await page.getByRole('button', { name: 'Refresh image' }).click(); await expect(page.getByRole('dialog')).toContainText('Decoded 7 × 9');
  expect((await pixels(page.getByRole('dialog'), { width: 7, height: 9, sha256: hash(readFileSync(join(root, '.saivage/work/current.png'))) })).left).toEqual([0, 255, 0, 255]);
  unlinkSync(join(root, '.saivage/work/current.png')); await page.getByRole('button', { name: 'Refresh image' }).click(); await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible(); await expect(page.getByRole('dialog').locator('img')).toHaveCount(0);
  for (const path of ['.saivage/auth-profiles.json', '.saivage/saivage.yaml', '.saivage/repair-attic/canary.png', '.saivage/work/attic-alias.png', `.saivage/agents/conversations/analyst/images/${selected.get(`${sessions[1]}:current`)![0].descriptor.id}.png`]) {
    const response = await page.request.get(`${origin}/api/files/image?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } }); expect(response.status()).toBe(403); report.push({ denied: path, status: response.status() });
  }
  expect(imageUrls.every(url => !url.includes(token) && !url.includes('token='))).toBe(true);
  // Navigate through the actual Vue router while the caller-local inspector is
  // open (programmatic navigation models owner departure despite background inert).
  await page.locator('a[href="/system"]').first().evaluate((element: HTMLAnchorElement) => element.click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  report.push({ callerDepartureClosedInspector: true });
  report.push({ imageUrlsContainNoToken: true, selectedHashes: [...selected.entries()].flatMap(([key, fixtures]) => fixtures.map(f => ({ sha256: f.descriptor.sha256, diskHash: hash(readFileSync(conversationImageFile(root, key.startsWith(sessions[0]) ? sessions[0] : sessions[1], f.descriptor.id))) }))) });
});
