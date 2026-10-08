import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { App } from '../../../src/boot/app.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/config/system-templates/registry.js';
import { createResolvedConfigAuthority } from '../../../src/config/index.js';
import { CardService } from '../../../src/cards/card-service.js';
import { appendConversationBatch, readConversationCatalog } from '../../../src/persistence/conversation-file.js';
import { publishConversationImage } from '../../../src/persistence/session-api.js';
import { agentMessageSchema, STRUCTURAL_ROW_POLICY, type ConversationSessionId } from '../../../src/schemas/index.js';
import { ToolResultSchema } from '../../../src/contracts/tool-result.js';
import { ViewImageDataSchema } from '../../../src/contracts/view-image.js';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import { describeNodeResultContract } from '../../../src/runtime/runtime-api.js';
import { formatVocabularySnippet } from '../../../src/tools/prompt-api.js';
import { redactTextForOutbound } from '../../../src/redaction/index.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import { productionTestConfig, writeProductionConfig, initializeProject, startProductionApp, appOrigin, listen, closeServer } from '../../helpers/production-composition-e2e.js';
import { publishThreeGenerationCompactedConversation } from '../../helpers/compacted-conversation-fixture.js';
import { toolRowPolicies, TEXT_ROW_POLICY } from '../../helpers/row-policy-fixtures.js';
import { seedTokenBeforeNavigation } from '../smoke/fixtures/operator-preview-sync.js';
import { currentConversationSegmentPath } from '../../helpers/current-conversation-segment-path.js';
import { cardHeadFile } from '../../../src/persistence/layout.js';

// Reuse the existing smoke harness's asset build/preview bootstrap. Every page
// navigation below targets the independently owned startApp origin, not preview.
test.describe.configure({ timeout: 120_000, retries: 0 });

const token = 'synthetic-reader-only-token';
const analyst = 'agent:analyst:global' as const;
const planner = 'agent:planner:project' as const;
const inputId = '00000000-0000-4000-8000-000000000088';
const timestamp = '2026-10-07T12:00:00.000Z';
// Follow-up outputs never replace the delivered reader's original evidence.
const evidence = fileURLToPath(new URL('../../../docs/working/2026-10-07-conversation-reading-ux/evidence/compact-summary/real-server/', import.meta.url));
const retainedCommand = `npm test -- ${'long_unbroken_argument_'.repeat(160)} final-command-Z`;
const longText = Array.from({ length: 40 }, (_, n) => `Retained line ${n}: ${'ordinary readable evidence '.repeat(8)}`).join('\n');
let root: string;
let app: App;
let origin: string;
let executor: ConversationSessionId;
let workflows: ReturnType<ReturnType<typeof createResolvedConfigAuthority>['loadEffective']>['workflows'];
let imageDescriptor: ReturnType<typeof publishConversationImage>;
const providerRequests: string[] = [];
const unchangedSelections = new Map<string, Buffer>();
const sink = createServer((request, response) => {
  providerRequests.push(`${request.method} ${request.url}`);
  response.writeHead(400); response.end('inert provider: calls forbidden');
});

async function seed(session: ConversationSessionId) {
  let index = 0;
  const row = (id: string, content: string, role: 'assistant' | 'user' | 'system' | 'tool' = 'assistant') => ({
    id, session_id: session, role, kind: 'text', content, context_policy: TEXT_ROW_POLICY,
    round_id: `r-${role === 'system' ? 'pre' : role === 'tool' ? 'assistant' : role}-${inputId.replaceAll('-', '')}`,
    message_index: index++, block_index: 0, timestamp,
  });
  const pair = (name: string, tool: string, args: object, result: object) => {
    const content = JSON.stringify(ToolResultSchema.parse(result));
    const policy = toolRowPolicies({ content,
      template: tool === 'view_image' ? OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE : OPERATIONAL_RESULT_POLICY_TEMPLATE,
      ...(tool === 'view_image' ? { evidence: { kind: 'observational_query' as const, observedSha256: createHash('sha256').update(content, 'utf8').digest('hex') } } : {}),
    });
    return [
      { ...row(`${inputId}:tool-call:${name}`, JSON.stringify({ role: 'assistant', tool_calls: [{ id: name, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] })), kind: 'tool_call', tool, tool_call_id: name, context_policy: policy.call },
      { ...row(`${inputId}:tool-result:${name}`, content, 'tool'), kind: 'tool_result', tool, tool_call_id: name, context_policy: policy.result },
    ];
  };
  // Valid selected raster; the browser must never request it or the original path.
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
  const image = publishConversationImage(root, session, png, { width: 1, height: 1 });
  if (session === executor) imageDescriptor = image;
  const command = pair('command', 'run_command', { command: retainedCommand, cwd: '.', wait: true }, {
    success: true, data: { process_id: 'proc-012345abcdef', status: 'exited', exit_code: 0,
      stdout: `${longText}\nfinal-stdout-Z`, stderr: 'final-stderr-Q', stdout_complete: true, stderr_complete: true,
      stdout_bytes: Buffer.byteLength(`${longText}\nfinal-stdout-Z`), stderr_bytes: 14 },
  });
  const rows = [
    { ...row(`${inputId}:activation`, JSON.stringify({ event: 'activation_open', agent_name: session.split(':')[1],
      ...(session === analyst ? {} : { card_id: session.split(':')[2] }), input_id: inputId, timestamp }), 'system'), kind: 'activity', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary },
    row('recorded-system', `${longText}\nfinal-system-Z`, 'system'),
    command[0], row('between', 'No result was known at this intervening prose.'), command[1], row('correction', 'Correction after result.'),
    ...pair('failed-command', 'run_command', { command: 'synthetic-failure' }, { success: false, error: 'Synthetic command failed: final-failure-Z' }),
    ...pair('image', 'view_image', { path: 'synthetic-screen.png', max_dimension: 1600 }, { success: true, image,
      data: ViewImageDataSchema.parse({ source_path: 'synthetic-screen.png', source_dimensions: { width: 1, height: 1 }, oriented_dimensions: { width: 1, height: 1 }, sent_dimensions: { width: 1, height: 1 }, orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600 }) }),
    row('tail', `${longText}\nfinal-transcript-Z`),
  ];
  appendConversationBatch({ projectRoot: root }, rows.map(r => agentMessageSchema.parse(r)));
}

test.beforeAll(async () => {
  const port = await listen(sink);
  root = mkdtempSync('/home/salva/g/ml/tmp/reading-real-server-');
  // Pin the existing helpers' environment-based bootstrap/config inputs to this
  // worker's owned fixture even when the invoking shell has deployment settings.
  process.env.SAIVAGE_PROJECT_ROOT = root;
  process.env.SAIVAGE_CONFIG = join(root, '.saivage/saivage.yaml');
  const config = productionTestConfig(port, config => {
    for (const [name, agent] of Object.entries(config.agents)) agent.tools = [...DEFAULT_SAIVAGE_CONFIG.agents[name]!.tools];
    config.providers.fixture!.capabilities = { ...config.providers.fixture!.capabilities, transportProtocol: 'openai-responses', imageInput: true };
    config.oversight.enabled = false;
    config.mcpServers = {};
    const nodes = config.card_types.code!.workflow.nodes;
    nodes.verify = structuredClone(nodes.execute!);
    nodes.execute!.edges.done!.target = { node: 'verify' };
  });
  writeProductionConfig(root, config);
  // Preserve actual bundled image guidance and compose an explicit fragment seam.
  const promptRoot = join(root, '.saivage/config/prompts');
  mkdirSync(join(promptRoot, 'agents/_shared'), { recursive: true });
  mkdirSync(join(promptRoot, 'fragments/_shared'), { recursive: true });
  writeFileSync(join(promptRoot, 'fragments/_shared/reader-canary.md'), 'api_key=fragment-canary\nsk-');
  for (const name of ['executor', 'analyst']) {
    const bundled = readFileSync(join(process.cwd(), `src/config/system-templates/classic/prompts/agents/_shared/${name}.md`), 'utf8');
    writeFileSync(join(promptRoot, `agents/_shared/${name}.md`), `${bundled}\n{{> reader-canary}}seam-canary\n${longText}\nfinal-loaded-instructions-Z`);
  }
  initializeProject(root);
  workflows = createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: {} }).loadEffective().workflows;
  const child = new CardService(root, workflows).create({ type: 'code', parent: 'project', title: 'Synthetic reader child', bootstrap_content: 'Synthetic brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  executor = `agent:executor:${child.id}` as ConversationSessionId;
  await seed(executor); await seed(analyst);
  await publishThreeGenerationCompactedConversation(root, `${longText}\nfinal-summary-Z`, {
    first: { content: `${longText}\nfirst-protected-Z`, key: 'reader-protected' },
    replacement: { content: `${longText}\nfinal-protected-Z`, key: 'reader-protected' },
  });
  for (const path of [cardHeadFile(root, 'project'), cardHeadFile(root, child.id), ...[executor, analyst, planner].map(session => currentConversationSegmentPath(root, session))]) unchangedSelections.set(path, readFileSync(path));
  app = await startProductionApp(root, token);
  origin = appOrigin(app);
  // An unactivated edit is not loaded configuration; expectedBindings retains
  // the exact compilation used at startup, as do the real server's actors.
  writeFileSync(join(promptRoot, 'agents/_shared/executor.md'), 'UNACTIVATED DISK CONTENT\n{{contractDescription}}');
  expect(providerRequests).toEqual([]);
});

test.afterAll(async () => {
  try {
    if (app) await app.stop();
    for (const [path, bytes] of unchangedSelections) expect(readFileSync(path)).toEqual(bytes);
  }
  finally {
    await closeServer(sink);
    if (root) rmSync(root, { recursive: true, force: true });
    expect(providerRequests).toEqual([]);
  }
});

function expectedBindings(session: ConversationSessionId) {
  const registry = createPromptTemplateRegistry(workflows);
  if (session === analyst) return [{ kind: 'global', instructions: redactTextForOutbound(registry.render(
    { kind: 'global-agent' }, 'analyst', { vocabularySnippet: formatVocabularySnippet(workflows.cardTypeVocabulary) })) }];
  const cardType = session === planner ? 'project' : 'code';
  const workflow = workflows.cardTypes.get(cardType)!;
  return [...workflow.states].flatMap(([id, state]) => state.kind === 'node' && state.agent.name === session.split(':')[1]
    ? [{ kind: 'workflow_node', node_id: state.nodeId, instructions: redactTextForOutbound(registry.render(
      { kind: 'workflow-agent', cardType }, state.agent.name, { contractDescription: describeNodeResultContract(workflow, id) })) }] : []);
}

async function instructions(page: Page, reader: Locator, session: ConversationSessionId, historical: boolean) {
  const disclosure = reader.locator('.current-instructions');
  await expect(disclosure).not.toHaveAttribute('open');
  const url = `/api/agents/${encodeURIComponent(session)}/current-instructions`;
  const wait = () => page.waitForResponse(r => new URL(r.url()).pathname === url && r.request().method() === 'GET');
  const opened = wait();
  await disclosure.locator('summary').click();
  const response = await opened;
  expect(response.status()).toBe(200);
  const dto = parseOperatorResponse('agents.currentInstructions', 200, await response.json());
  expect(dto.bindings).toEqual(expectedBindings(session));
  expect(JSON.stringify(dto)).not.toContain('canary');
  if (historical) await expect(disclosure).toContainText('not the instructions recorded for this historical segment');
  const blocks = disclosure.locator('section .code-block');
  await expect(blocks).toHaveCount(dto.bindings.length);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  for (let i = 0; i < dto.bindings.length; i++) {
    await expect(blocks.nth(i).locator('pre')).toHaveText(dto.bindings[i]!.instructions);
    await blocks.nth(i).getByRole('button', { name: 'copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(dto.bindings[i]!.instructions);
  }
  const refreshed = wait(); await disclosure.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(parseOperatorResponse('agents.currentInstructions', 200, await (await refreshed).json())).toEqual(dto);
  return dto;
}

async function capture(page: Page, reader: Locator, name: string, expectOverflow = false) {
  const geometry = await reader.evaluate(container => {
    const painted = [container, ...container.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const owners = painted.filter(e => e.matches('.conversation-reading-surface, .chat-scroll-area'));
    const owner = owners[0];
    // The Analyst composer is a sibling, not conversation content. Within the
    // actual reading owner reject nested CSS scrollports even when they fit.
    const content = painted.filter(e => e === owner || owner?.contains(e));
    const metrics = (e: Element) => ({ classes: e.className, height: e.clientHeight, extent: e.scrollHeight,
      overflowY: getComputedStyle(e).overflowY, isOwner: e === owner });
    return { owners: owners.map(metrics),
      nestedScrollOwners: content.filter(e => e !== owner && /auto|scroll/.test(getComputedStyle(e).overflowY)).map(metrics),
      scrollports: content.filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(metrics),
      pageWidth: document.documentElement.clientWidth, pageExtent: document.documentElement.scrollWidth,
      anchors: painted.filter(e => e.hasAttribute('data-entry-id')).map(e => ({ id: e.getAttribute('data-entry-id'), y: e.getBoundingClientRect().y })) };
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${name}.geometry.json`), JSON.stringify({ ...geometry, expectOverflow }, null, 2));
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
  expect(geometry.owners, `${name}: exactly one identified reading owner`).toHaveLength(1);
  expect(geometry.owners[0]!.overflowY, `${name}: owner CSS`).toMatch(/^(auto|scroll)$/);
  expect(geometry.nestedScrollOwners, `${name}: no nested CSS scrollports, overflowing or not`).toEqual([]);
  expect(geometry.scrollports.length, `${name}: at most one overflowing owner`).toBeLessThanOrEqual(1);
  expect(geometry.scrollports.every(e => e.isOwner)).toBe(true);
  if (expectOverflow) expect(geometry.scrollports, `${name}: known long content must overflow its owner`).toHaveLength(1);
  expect(geometry.pageExtent).toBeLessThanOrEqual(geometry.pageWidth + 1);
}

async function compactCommand(reader: Locator, evidenceName: string, context: 'row-and-following' | 'mobile-child-row-only' = 'row-and-following') {
  const row = reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`);
  await expect(row.locator('.tool-chip-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.tool-chip-target')).toContainText('npm test -- long_unbroken_argument_');
  await row.scrollIntoViewIfNeeded();
  // The mobile child reader's existing chrome leaves a 126px owner: the
  // measured 118px row fits, but its 181px union with prose cannot. That one
  // scene captures row and prose separately; the global inspector proves the
  // simultaneous mobile scene without altering card chrome or summary metrics.
  await row.evaluate((el, context) => {
    const owner = el.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
    const following = owner.querySelector('[data-entry-id="between"]')!;
    const bounds = owner.getBoundingClientRect(), top = bounds.top + owner.clientTop;
    const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
    const bottom = Math.min(top + owner.clientHeight, innerHeight, footer.height > 0 ? footer.top : innerHeight);
    const first = el.getBoundingClientRect(), last = following.getBoundingClientRect();
    const groupHeight = context === 'mobile-child-row-only' ? first.height : last.bottom - first.top;
    owner.scrollTop += first.top - top - Math.max(0, (bottom - top - groupHeight) / 2);
  }, context);
  await row.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const metrics = await row.evaluate(el => {
    const button = el.querySelector<HTMLElement>('.tool-chip-toggle')!, target = el.querySelector<HTMLElement>('.tool-chip-target')!;
    const owner = el.closest<HTMLElement>('.conversation-reading-surface, .chat-scroll-area')!;
    const r = target.getBoundingClientRect(), line = parseFloat(getComputedStyle(target).lineHeight);
    const parts = ['action', 'target', 'status'].map(name => el.querySelector(`.tool-chip-${name}`)!.getBoundingClientRect());
    const bounds = owner.getBoundingClientRect(), whole = el.getBoundingClientRect();
    const following = owner.querySelector(`[data-entry-id="between"]`)!.getBoundingClientRect();
    const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
    const ownerTop = bounds.top + owner.clientTop;
    const ownerBottom = Math.min(ownerTop + owner.clientHeight, innerHeight, footer.height > 0 ? footer.top : innerHeight);
    return { width: r.width, height: r.height, line, buttonHeight: button.getBoundingClientRect().height, paneWidth: owner.clientWidth,
      ownerTop, ownerBottom, ownerHeight: ownerBottom - ownerTop, groupHeight: following.bottom - whole.top,
      rowTop: whole.top, rowBottom: whole.bottom, followingTop: following.top, followingBottom: following.bottom,
      font: getComputedStyle(target).fontSize, overflow: button.scrollWidth > button.clientWidth + 1,
      rowVisible: whole.top >= ownerTop && whole.bottom <= ownerBottom,
      visible: whole.top >= ownerTop && whole.bottom <= ownerBottom && following.top >= ownerTop && following.bottom <= ownerBottom,
      overlap: parts.some((a, i) => parts.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)) };
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${evidenceName}.geometry.json`), JSON.stringify({ ...metrics, context,
    contextLimitation: context === 'mobile-child-row-only' ? 'Existing child header and participant rail: row + following prose cannot fit simultaneously; captured separately. Global mobile inspector supplies simultaneous evidence.' : null }, null, 2));
  if (context === 'row-and-following') {
    expect(metrics.groupHeight, 'actual owner must fit the whole closed row and following prose without footer clipping').toBeLessThanOrEqual(metrics.ownerHeight);
    expect(metrics.visible).toBe(true);
  } else {
    expect(metrics.groupHeight, 'record the evidenced mobile child chrome limitation explicitly').toBeGreaterThan(metrics.ownerHeight);
  }
  expect(metrics.width).toBeGreaterThanOrEqual(64);
  expect(metrics.height).toBeLessThanOrEqual(metrics.line + 1);
  const lines = metrics.paneWidth >= 450 ? 2 : 3;
  expect(metrics.buttonHeight).toBeLessThanOrEqual(lines * metrics.line + 12 + (lines - 1) * 8 + 1);
  expect(metrics.font).toBe('15px'); expect(metrics.overlap).toBe(false); expect(metrics.overflow).toBe(false); expect(metrics.rowVisible).toBe(true);
  return metrics;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1296, height: 899 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
  test(`real authenticated retained reading ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await seedTokenBeforeNavigation(page, token);
    const requests: Array<{ method: string; path: string }> = []; const errors: string[] = [];
    page.on('request', r => requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
    page.on('pageerror', e => errors.push(e.message));
    const reads = (session: string) => requests.filter(r => r.method === 'GET' && decodeURIComponent(r.path) === `/api/agents/${session}/current-instructions`).length;
    await page.goto(`${origin}/agents/${executor}`);
    const reader = page.locator('.conversation-container');
    await expect(reader).toContainText('final-transcript-Z');
    expect(requests.filter(r => r.path.endsWith('/current-instructions'))).toEqual([]);
    const apiPath = `/api/agents/${encodeURIComponent(executor)}/conversation`;
    expect((await page.request.get(`${origin}${apiPath}`)).status()).toBe(401);
    const retained = await page.request.get(`${origin}${apiPath}`, { headers: { authorization: `Bearer ${token}` } });
    expect(retained.status()).toBe(200);
    const publicConversation = parseOperatorResponse('agents.conversation', 200, await retained.json());
    expect(publicConversation.segment_context).toBeNull();
    expect(publicConversation.entries.map(e => e.id)).toContain(`${inputId}:tool-result:image`);
    expect(JSON.stringify(publicConversation)).not.toMatch(/provider_projection|producer_account_id|data:image|base64/);
    await expect(reader).toContainText('Image snapshot recorded');
    await expect(reader).toContainText('Synthetic command failed');
    await compactCommand(reader, `${viewport.width}-child-compact-command`, viewport.width === 390 ? 'mobile-child-row-only' : 'row-and-following');
    await capture(page, reader, `${viewport.width}-child-compact-command-default`);
    if (viewport.width === 390) {
      const following = reader.locator('[data-entry-id="between"]');
      await following.scrollIntoViewIfNeeded();
      await following.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      expect(await following.evaluate(el => {
        const owner = el.closest<HTMLElement>('.conversation-reading-surface')!;
        const bounds = owner.getBoundingClientRect(), text = el.getBoundingClientRect();
        const top = bounds.top + owner.clientTop;
        const footer = document.querySelector('.mobile-pane-switch')!.getBoundingClientRect();
        return text.top >= top && text.bottom <= Math.min(top + owner.clientHeight, footer.top);
      }), 'following prose fits separately after ordinary owner scroll').toBe(true);
      await capture(page, reader, '390-child-compact-command-following-separate');
      await page.goto(`${origin}/agents/${analyst}`);
      await expect(page.locator('.global-session-reader')).toBeVisible();
      await expect(reader).toContainText('final-transcript-Z');
      await compactCommand(reader, '390-global-analyst-inspector-compact-command');
      await capture(page, reader, '390-global-analyst-inspector-compact-command-default');
      await page.goto(`${origin}/agents/${executor}`);
      await expect(reader).toContainText('final-transcript-Z');
    }
    await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
    await capture(page, reader, `${viewport.width}-child-current-context-instructions-default`);
    const dto = await instructions(page, reader, executor, false);
    expect(reads(executor)).toBe(2); // exactly open + explicit Refresh
    expect(dto.bindings.map(b => b.kind === 'workflow_node' ? b.node_id : 'global')).toEqual(['execute', 'verify']);
    expect(dto.bindings.every(b => b.instructions.includes('view_image') && b.instructions.endsWith('final-loaded-instructions-Z'))).toBe(true);
    await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
    await capture(page, reader, `${viewport.width}-child-current-instructions-expanded`, true);
    await reader.locator('.current-instructions summary').click();
    await expect(reader.locator('.current-instructions section')).toHaveCount(0);
    const reopened = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/current-instructions'));
    await reader.locator('.current-instructions summary').click(); await reopened;
    expect(reads(executor)).toBe(3); // reopening performs a fresh ordinary read
    await reader.locator('.current-instructions summary').click();
    // Cold exact call and result targets reveal their distinct anchors in one row.
    for (const half of ['call', 'result']) {
      const id = `${inputId}:tool-${half}:command`;
      await page.goto(`${origin}/agents/${executor}?segment=1&entry=${encodeURIComponent(id)}`);
      const anchor = reader.locator(`[data-entry-id="${id}"]`);
      await expect(anchor).toBeFocused();
      await expect(reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`)).toHaveCount(1);
      await expect(reader).toContainText('Result recorded later');
      if (half === 'result') {
        const exchange = reader.locator(`[data-tool-entry-id="${inputId}:tool-call:command"]`);
        await expect(exchange.locator('.tool-chip-status')).toContainText('Exited');
        await expect(exchange.locator('.tool-chip-status')).toContainText('exit 0');
        await expect(exchange.locator('.tool-chip-status')).not.toContainText('Passed');
        await anchor.locator('details:not(.safe-original)').evaluateAll(es => es.forEach(e => { (e as HTMLDetailsElement).open = true; }));
        const outputs = anchor.locator('.semantic-section details[open] pre');
        await expect(outputs).toHaveCount(2);
        await expect(outputs.nth(0)).toBeVisible();
        await expect(outputs.nth(1)).toBeVisible();
        await expect(anchor).toContainText('final-stdout-Z');
        await expect(anchor).toContainText('final-stderr-Q');
        await capture(page, reader, `${viewport.width}-child-exact-command-output-expanded`, true);
      }
      await anchor.locator('details.safe-original').evaluate(e => { (e as HTMLDetailsElement).open = true; });
      const raw = anchor.locator('details.safe-original');
      await expect(raw.locator('pre')).toContainText(half === 'call' ? retainedCommand : 'final-stdout-Z');
      const safeReceived = await raw.locator('pre').textContent();
      await raw.getByRole('button', { name: 'copy', exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(safeReceived);
      await capture(page, reader, `${viewport.width}-child-exact-command-${half}-raw-expanded`, true);
    }
    await page.goto(`${origin}/agents/${executor}?segment=1&entry=${encodeURIComponent(`${inputId}:tool-result:image`)}`);
    const image = reader.locator(`[data-entry-id="${inputId}:tool-result:image"]`);
    await expect(image).toBeFocused();
    await image.locator('details.safe-original').evaluate(e => { (e as HTMLDetailsElement).open = true; });
    await expect(image.locator('details.safe-original pre')).toContainText(imageDescriptor.sha256);
    await expect(image.locator('details.safe-original pre')).toContainText(imageDescriptor.id);
    await expect(image.locator('a')).toHaveCount(0);
    await expect(reader.locator('img')).toHaveCount(0);
    await capture(page, reader, `${viewport.width}-image-metadata`);
    const catalog = readConversationCatalog(root, planner);
    for (const version of [null, 1, 2, 3]) {
      await page.goto(`${origin}/agents/${planner}${version ? `?segment=${version}` : ''}`);
      await expect(reader).toContainText(`Conversation · ${version ? 'exact' : 'current'} segment ${version ?? catalog.currentVersion}`);
      expect(reads(planner)).toBe(version === null ? 0 : version === 3 ? 4 : 2);
      const selection = version === null ? 'current' : `exact-${version}`;
      await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
      await expect(reader.locator('.current-instructions')).not.toHaveAttribute('open');
      if (version !== 1) await expect(reader.locator('[data-testid="conversation-segment-context"]')).not.toHaveAttribute('open');
      await capture(page, reader, `${viewport.width}-planner-${selection}-context-instructions-default`);
      if (version !== 1) {
        const context = reader.locator('[data-testid="conversation-segment-context"]');
        await expect(context).toContainText('Compacted context');
        await context.evaluate(e => { const d = e.closest('details'); if (d) d.open = true; e.querySelectorAll('details').forEach(d => { d.open = true; }); });
        await expect(context).toContainText('final-summary-Z');
        await expect(context).toContainText(version === 2 ? 'first-protected-Z' : 'final-protected-Z');
        await capture(page, reader, `${viewport.width}-planner-${selection}-context-expanded`, true);
      } else await expect(reader.locator('[data-testid="conversation-segment-context"]')).toHaveCount(0);
      const history = reader.locator('details.version-history');
      if (await history.getAttribute('open') === null) await history.locator('summary').click();
      await expect(reader.getByRole('button', { name: /Segment 1/ })).toBeVisible();
      if (version === null || version === 2) {
        await instructions(page, reader, planner, version !== null);
        await reader.locator('.conversation-reading-surface').evaluate(e => { e.scrollTop = 0; });
        await capture(page, reader, `${viewport.width}-planner-${selection}-context-instructions-expanded`, true);
      }
      if (version === 2) {
        // Exercise actual history controls and browser Back, not cold routes alone.
        await history.getByRole('button', { name: /Segment 1/ }).click();
        await expect(reader).toContainText('Conversation · exact segment 1');
        await expect(reader.locator('[data-testid="conversation-segment-context"]')).toHaveCount(0);
        await page.goBack();
        await expect(reader).toContainText('Conversation · exact segment 2');
        await expect(reader.locator('.current-instructions')).toContainText('not the instructions recorded for this historical segment');
        expect(reads(planner)).toBe(4); // same-session history does not refetch current configuration
      }
    }
    if (viewport.width === 390) await page.getByRole('navigation', { name: 'Switch pane' }).getByRole('button', { name: 'Analyst', exact: true }).click();
    const chat = page.locator('.analyst-chat-panel');
    await expect(chat).toContainText('final-transcript-Z');
    await expect(chat).toContainText('Image snapshot recorded');
    await compactCommand(chat, `${viewport.width}-shared-analyst-compact-command`);
    await capture(page, chat, `${viewport.width}-shared-analyst-compact-command-default`);
    expect(reads(analyst)).toBe(0);
    await chat.locator('.chat-scroll-area').evaluate(e => { e.scrollTop = 0; });
    await capture(page, chat, `${viewport.width}-shared-analyst-current-instructions-default`);
    await instructions(page, chat, analyst, false);
    expect(reads(analyst)).toBe(2);
    await chat.locator('.chat-scroll-area').evaluate(e => { e.scrollTop = 0; });
    await capture(page, chat, `${viewport.width}-shared-analyst-current-instructions-expanded`, true);
    expect(requests.some(r => /\/images\/|synthetic-screen\.png/.test(r.path))).toBe(false);
    // GET /api/chat is the mounted Analyst's legitimate retained baseline read.
    // The real authenticated WS lease also obtains its existing ephemeral auth
    // ticket via POST; that is not a target-history mutation or chat submission.
    expect(requests.filter(r => r.path === '/api/chat' && r.method !== 'GET')).toEqual([]);
    expect(requests.filter(r => r.path.startsWith('/api/') && !['GET', 'HEAD'].includes(r.method)
      && !(r.method === 'POST' && r.path === '/api/auth/ws-ticket'))).toEqual([]);
    expect(errors).toEqual([]); expect(providerRequests).toEqual([]);
    writeFileSync(join(evidence, `${viewport.width}-requests.json`), JSON.stringify(requests, null, 2));
  });
}
