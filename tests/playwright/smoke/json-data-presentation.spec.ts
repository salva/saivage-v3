import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { toolRowPolicies } from '../../helpers/row-policy-fixtures.js';
import { installOperatorRestRoutes, retainedInstructionContext, smokeCardId } from './fixtures/operator-rest-fixtures.js';
import { installOperatorWebSocketShim } from './fixtures/operator-websocket-shim.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

// Explicitly run: SAIVAGE_JSON_EVIDENCE_DIR=/home/salva/g/ml/tmp/2026-10-07-ui-json-highlighting
// npx playwright test --config tests/playwright/smoke/playwright.config.ts json-data-presentation.spec.ts
// Synthetic public API data only; this spec is intentionally outside the hard-coded routine smoke list.
const session = `agent:executor:${smokeCardId}`;
const segment = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-07T12:00:00.000Z';
const malicious = '</code><img src=x onerror="window.jsonInjected=true"><script>window.jsonInjected=true</script>&';
const irregular = ` {\r\n\t"duplicate":1, "duplicate" : 2,\r\n "large":900719925474099312345, "minus":-0, "exp":1.2300e+04,\r\n "literal":${JSON.stringify(malicious)}, "escaped":"\\u263a", "ok":true, "empty":null\r\n }\t\n`;
const inline = { revision: 3, ok: true, missing: null };
const config = parseOperatorResponse('config.get', 200, { config: TEST_SAIVAGE_CONFIG, warnings: ['Synthetic saved-configuration warning.'] });
const exchange = parseOperatorResponse('agents.llmExchange', 200, { session_id: session, exchange: {
  contract_id: 'executor.v1', contract_name: 'executor', transport: 'generic', provider: 'test', model: 'test-model',
  source_input_id: 'synthetic-input', attempt_index: 0,
  request_params: { endpoint: 'https://synthetic.invalid/v1/chat/completions', method: 'POST', temperature: 0, max_tokens: 1000, stream: false, offered_tools_count: 1 },
  started_at: timestamp, completed_at: timestamp, status: 'ok', response_status: 200,
  terminal_tool_fired: null, assistant_output_ids: ['synthetic-output'], token_usage: { cached_input_tokens: 0 },
} });

function pair(id: string, tool: string, args: object, result: object) {
  const content = JSON.stringify(result);
  const policies = toolRowPolicies({ content });
  const base = { session_id: session, tool, tool_call_id: id, message_index: 0, block_index: 0, timestamp,
    round_id: `r-assistant-${segment.replaceAll('-', '')}` };
  return [
    { ...base, id: `${segment}:tool-call:${id}`, role: 'assistant', kind: 'tool_call', context_policy: policies.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }) },
    { ...base, id: `${segment}:tool-result:${id}`, role: 'tool', kind: 'tool_result', context_policy: policies.result, content },
  ];
}
function prose(id: string, content: string) {
  return { id, session_id: session, role: 'assistant', kind: 'text', content, timestamp,
    round_id: `r-assistant-${segment.replaceAll('-', '')}`, message_index: 0, block_index: 0,
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true } };
}
const initialRows = [
  ...pair('config', 'show_config', { literal: malicious }, { success: true, data: { config: {
    agents: { worker: { label: malicious, enabled: true, limit: 0, absent: null } }, card_types: ['code'],
    models: { routes: { worker: ['test-model'] } }, providers: { test: { models: ['test-model'] } },
  } } }),
  ...pair('failed', 'unknown_tool', {}, { success: false, error: 'Synthetic refusal prose', data: { current_head: inline, resource: { literal: malicious } } }),
  ...Array.from({ length: 30 }, (_, i) => prose(`tail-${i}`, `Reading-position context ${i}: ${'Retained public prose. '.repeat(8)}`)),
];
const arrivalRows = pair('arrival', 'unknown_tool', { literal: malicious }, { success: true, data: { literal: malicious, values: [1, true, null] } });

async function setup(page: Page) {
  await seedTokenBeforeNavigation(page, 'synthetic-json-presentation-token');
  await installOperatorWebSocketShim(page);
  const rest = await installOperatorRestRoutes(page);
  let arrived = false;
  await page.route('**/api/agents/*/conversation**', async route => {
    const url = new URL(route.request().url());
    if (decodeURIComponent(url.pathname) !== `/api/agents/${session}/conversation`) return route.fallback();
    const all = [...initialRows, ...(arrived ? arrivalRows : [])];
    const since = url.searchParams.get('since');
    const index = since === null ? -1 : all.findIndex(row => row.id === since);
    const body = parseOperatorResponse('agents.conversation', 200, { session_id: session, segment_id: segment, segment_version: 2,
      segment_context: retainedInstructionContext(session), entries: index < 0 ? all : all.slice(index + 1),
      cursor: { segment_id: segment, segment_version: 2, message_id: all.at(-1)!.id } });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/agents/*/llm-exchange', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(exchange) }));
  await page.route('**/api/config', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(config) }));
  await page.route('**/api/files?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!['.saivage/work/irregular.json', '.saivage/work/ordinary.log', '.saivage/work/oversized.json'].includes(path!)) return route.fallback();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(
      parseOperatorResponse('files.list', 400, { error: 'Path is not a directory', path })) });
  });
  await page.route('**/api/files/content**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    const content = path.endsWith('oversized.json') ? `"${'x'.repeat(1_000_000)}"` : path.endsWith('.log') ? '{"ordinary log":true}\n' : irregular;
    const body = parseOperatorResponse('files.content', 200, { path, content, size: Buffer.byteLength(content),
      contentType: path.endsWith('.log') ? 'text/plain' : 'application/json', redacted: true, sensitivity: 'sensitive-redacted' });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { rest, arrive: () => { arrived = true; } };
}

async function expand(row: Locator) {
  const toggle = row.locator('.tool-chip-toggle');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
async function copy(page: Page, block: Locator, text: string) {
  await block.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
}

// Capture computed styles from actual rendered tokens, compositing ancestor backgrounds
// (including translucent error surfaces). No injected styles or test-only UI owners.
async function measure(owner: Locator) {
  return owner.locator('.json-text').evaluateAll(elements => {
    const rgba = (value: string) => {
      const numbers = value.match(/[\d.]+/g)!.map(Number);
      return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3] ?? 1];
    };
    const background = (element: Element) => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
      return chain.reduce((base, node) => {
        const color = rgba(getComputedStyle(node).backgroundColor);
        return base.map((c, i) => c * (1 - color[3]!) + color[i]! * color[3]!);
      }, [255, 255, 255]);
    };
    const luminance = (color: number[]) => color.reduce((sum, value, i) => {
      const v = value / 255;
      return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const samples = elements.flatMap(element => Array.from(element.children).map(token => {
      const style = getComputedStyle(token);
      const bg = background(token);
      const fg = rgba(style.color).slice(0, 3);
      const a = luminance(fg), b = luminance(bg);
      return { kind: token.className, foreground: style.color, background: bg, fontSize: style.fontSize,
        lineHeight: style.lineHeight, fontFamily: style.fontFamily, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    }));
    return [...new Map(samples.map(sample => [JSON.stringify(sample), sample])).values()];
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
  test(`lossless JSON data inspection at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fixture = await setup(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const directory = process.env.SAIVAGE_JSON_EVIDENCE_DIR ?? testInfo.outputPath('json-evidence');
    await mkdir(directory, { recursive: true });
    const evidence: Record<string, unknown> = { viewport, source: 'synthetic public API fixtures' };
    const capture = async (name: string, owner: Locator) => {
      const conversationOwned = await owner.evaluate(element => element.closest('.conversation-reading-surface, .chat-scroll-area') !== null);
      const samples = await measure(owner);
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(parseFloat(sample.fontSize)).toBeGreaterThanOrEqual(14);
        expect(parseFloat(sample.fontSize)).toBeLessThanOrEqual(16);
        if (conversationOwned) {
          expect(parseFloat(sample.lineHeight)).toBeGreaterThanOrEqual(21);
          expect(parseFloat(sample.lineHeight)).toBeLessThanOrEqual(24);
        } else expect(parseFloat(sample.lineHeight)).toBe(21);
        expect(sample.contrast, `${name}: ${sample.kind} on ${sample.background}`).toBeGreaterThanOrEqual(4.5);
      }
      evidence[name] = samples;
      const checkCopyGeometry = async () => {
        const controls = await owner.evaluate(element => {
          const selector = '.code-block--json.code-block--copyable';
          const blocks = [...element.querySelectorAll(selector)];
          if (element.matches(selector)) blocks.unshift(element);
          return blocks.map(block => {
            const pre = block.querySelector('pre')!;
            const shell = block.getBoundingClientRect(), p = pre.getBoundingClientRect();
            const b = block.querySelector('button')!.getBoundingClientRect();
            const text = pre.querySelector('.json-text')!.getBoundingClientRect();
            return { buttonWithin: b.left >= shell.left && b.right <= shell.right && b.top >= shell.top && b.bottom <= shell.bottom,
              viewportBelow: p.top >= b.bottom, viewportTop: p.top, buttonBottom: b.bottom,
              textTop: text.top, scrollTop: pre.scrollTop };
          });
        });
        // Scrolled text bounds may extend above the viewport. The non-scrolling
        // pre viewport must stay below the button so clipped text cannot overlap it.
        for (const control of controls) {
          expect(control.buttonWithin).toBe(true);
          expect(control.viewportBelow).toBe(true);
        }
        return controls;
      };
      const initialGeometry = await checkCopyGeometry();
      // Owner boxes can extend far beyond the cockpit's scroll viewport. Photograph
      // the actual visible page after scrolling a JSON token, never that offscreen box.
      const tokens = owner.locator('.json-text > [class^="json-token-"]');
      const first = tokens.first(), last = tokens.last();
      const scrollPosition = (token: Locator) => token.evaluate(element => {
        const owners = [];
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
            owners.push({ owner: node.className, top: node.scrollTop, left: node.scrollLeft,
              height: node.clientHeight, scrollHeight: node.scrollHeight,
              width: node.clientWidth, scrollWidth: node.scrollWidth });
          }
        }
        return owners;
      });
      await first.evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' }));
      await expect(first).toBeInViewport();
      const start = await scrollPosition(first);
      const startGeometry = await checkCopyGeometry();
      await page.screenshot({ path: join(directory, `${viewport.width}-${name}.png`) });
      await last.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect(last).toBeInViewport();
      const end = await scrollPosition(last);
      const endGeometry = await checkCopyGeometry();
      if (viewport.width === 900) {
        await page.screenshot({ path: join(directory, `${viewport.width}-${name}-body-end.png`) });
      }
      const buttons = owner.getByRole('button', { name: /^(copy|copied)$/ });
      const copyGeometry = [];
      for (const button of await buttons.all()) {
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        await button.click({ trial: true });
        copyGeometry.push(await checkCopyGeometry());
      }
      evidence[`${name}-copy-geometry`] = { initial: initialGeometry, start: startGeometry, end: endGeometry, copyPositions: copyGeometry };
      if (viewport.width === 900 && await buttons.count()) {
        await page.screenshot({ path: join(directory, `${viewport.width}-${name}-copy-reachable.png`) });
      }
      evidence[`${name}-scroll-visibility`] = { start, end, copyButtonsReachable: await buttons.count(),
        note: 'First and last JSON tokens viewed separately through existing scrolling; copy buttons scrolled into view and hit-tested. Not a claim that the complete body fits simultaneously.' };
    };
    await page.goto(`/agents/${session}`);
    const cockpit = page.getByTestId('route-cockpit');
    const reader = cockpit.locator('.conv-rounds');
    const chip = (id: string) => reader.locator(`.tool-chip[data-tool-entry-id="${segment}:tool-call:${id}"]`);
    const row = (id: string, result = false) => reader.locator(`[data-entry-id="${segment}:tool-${result ? 'result' : 'call'}:${id}"]`);
    await expect(chip('config')).toBeVisible();
    await expand(chip('config'));
    await expect(chip('config').locator('[data-entry-id]')).toHaveCount(2);
    await expect(row('config')).toHaveCount(1);
    await expect(row('config', true)).toHaveCount(1);
    const requestOriginal = row('config').locator('.safe-original');
    await expect(requestOriginal).not.toHaveAttribute('open', '');
    await requestOriginal.locator(':scope > summary').click();
    const rawCall = requestOriginal.locator('.code-block');
    expect(await rawCall.locator('code').textContent()).toBe(initialRows[0]!.content);
    await copy(page, rawCall, initialRows[0]!.content);
    await capture('safe-original-request', rawCall);
    const inlineConfig = row('config', true).locator('.semantic-section').filter({ has: page.getByRole('heading', { name: 'Agent / workflow configuration', exact: true }) });
    await expect(inlineConfig.locator('.json-token-key').first()).toBeVisible();
    await capture('inline-show-config', inlineConfig);
    const resultOriginal = row('config', true).locator('.safe-original');
    await expect(resultOriginal).not.toHaveAttribute('open', '');
    await resultOriginal.locator(':scope > summary').click();
    await expect(requestOriginal).toHaveAttribute('open', '');
    const rawResult = resultOriginal.locator('.code-block');
    expect(await rawResult.locator('code').textContent()).toBe(initialRows[1]!.content);
    await copy(page, rawResult, initialRows[1]!.content);
    await capture('safe-original-result', rawResult);
    await expand(chip('failed'));
    const refusal = row('failed', true).locator('.semantic-section').filter({ has: page.getByRole('heading', { name: 'Recorded refusal / error context', exact: true }) });
    await capture('error-inline', refusal);
    const selected = refusal.locator('dl > div').filter({ has: page.getByText('current head', { exact: true }) }).locator('.json-text');
    expect(await selected.textContent()).toBe(JSON.stringify(inline));
    // Evidence capture visits body endpoints; center the selection target again so
    // the real mouse drag does not trigger edge auto-scrolling in the reader.
    await selected.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    // Real mouse selection across Vue token spans, not a programmatically installed Range.
    const endpoints = await selected.evaluate(element => {
      const first = element.firstElementChild!, last = element.lastElementChild!;
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { start: { x: a.left, y: a.top + a.height / 2 }, end: { x: b.right, y: b.top + b.height / 2 } };
    });
    await page.mouse.move(endpoints.start.x, endpoints.start.y);
    await page.mouse.down();
    await page.mouse.move(endpoints.end.x, endpoints.end.y, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(JSON.stringify(inline));
    evidence.mouseSelection = JSON.stringify(inline);
    await page.evaluate(() => getSelection()?.removeAllRanges());

    const compactedContext = cockpit.getByTestId('conversation-segment-context');
    await expect(compactedContext).not.toHaveAttribute('open', '');
    await compactedContext.locator(':scope > summary').click();
    const source = cockpit.getByTestId('compacted-source');
    await expect(source).not.toHaveAttribute('open', '');
    const summary = source.locator('summary');
    await summary.focus();
    await summary.press('Enter');
    await expect(summary).toBeFocused();
    await expect(source).toHaveAttribute('open', '');
    evidence.nativeDisclosureFocus = await summary.evaluate(element => {
      const style = getComputedStyle(element);
      return { focused: element === document.activeElement, outline: style.outline, outlineOffset: style.outlineOffset };
    });
    await expect(source.getByRole('button', { name: /copy/i })).toHaveCount(0);
    await capture('compacted-continuation', source);
    await summary.press('Space');
    await expect(source).not.toHaveAttribute('open', '');
    await summary.press('Enter');

    // Owner identity and disclosures survive append-only progressive arrival. This
    // does not pretend backend tool JSON streams incomplete strings.
    const mounted = await source.elementHandle();
    const mountedRaw = await rawResult.elementHandle();
    await reader.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event('scroll')); });
    const offset = await reader.evaluate(element => element.scrollTop);
    fixture.arrive();
    const response = page.waitForResponse(r => decodeURIComponent(new URL(r.url()).pathname) === `/api/agents/${session}/conversation`);
    await page.evaluate(id => window.__saivageWsFixture!.emit({ t: 'invalidate', resource: 'conversation', id,
      segment_id: '11111111-1111-4111-8111-111111111111', segment_version: 2,
      visible_message_id: '11111111-1111-4111-8111-111111111111:tool-result:arrival' }), session);
    await response;
    await expect(chip('arrival')).toHaveCount(1);
    expect(await mounted!.evaluate(element => element === document.querySelector('[data-testid="route-cockpit"] [data-testid="compacted-source"]'))).toBe(true);
    expect(await mountedRaw!.evaluate(element => element.isConnected)).toBe(true);
    await expect(source).toHaveAttribute('open', '');
    expect(await reader.evaluate(element => element.scrollTop)).toBe(offset);
    evidence.progressiveArrival = { mountedOwnerUnchanged: true, disclosureOpen: true, readingOffset: offset };
    await expand(chip('arrival'));
    await expect(row('arrival', true)).toHaveCount(1);
    const arrivalOriginal = row('arrival', true).locator('.safe-original');
    await expect(arrivalOriginal).not.toHaveAttribute('open', '');
    const arrivalSemantic = row('arrival', true).locator('.semantic-section').filter({ has: page.getByRole('heading', { name: 'Safe result (opaque tool)', exact: true }) });
    await capture('arrived-json', arrivalSemantic);
    await expect(arrivalOriginal).not.toHaveAttribute('open', '');

    await cockpit.locator('.technical-details > summary').click();
    const provider = cockpit.getByRole('region', { name: 'Provider exchange metadata' });
    await expect(provider.locator('.json-text').first()).toBeVisible();
    await capture('provider-metadata', provider);
    await copy(page, provider.locator('.code-block').first(), JSON.stringify(exchange.exchange.request_params, null, 2));
    const settlement = JSON.parse((await provider.locator('code').nth(1).textContent())!);
    expect(settlement.token_usage).toEqual({ cached_input_tokens: 0 });
    expect(settlement.token_usage).not.toHaveProperty('prompt_tokens');
    expect(await cockpit.locator('.json-text img, .json-text script, .json-text a, .json-text [onerror]').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { jsonInjected?: boolean }).jsonInjected)).toBeUndefined();
    await page.screenshot({ path: join(directory, `${viewport.width}-cockpit-page.png`) });

    await page.goto('/system?section=configuration');
    const system = page.getByTestId('system-configuration');
    await expect(system.locator('.config-json')).toHaveAttribute('open', '');
    await capture('system-config', system);
    await copy(page, system.locator('.code-block'), JSON.stringify(config.config, null, 2));
    // There is no current JSON-in-warning owner: record the actual warning surface
    // background for the review matrix without adding JSON to production banners.
    const warningBackground = await system.locator('.status-banner').evaluate(element => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
      return chain.reduce((base, node) => {
        const color = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)!.map(Number);
        const alpha = color[3] ?? 1;
        return base.map((value, i) => value * (1 - alpha) + color[i]! * alpha);
      }, [255, 255, 255]);
    });
    const luminance = (color: number[]) => color.reduce((sum, value, i) => {
      const v = value / 255;
      return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const warningMatrix = (await measure(system)).map(sample => {
      const foreground = sample.foreground.match(/[\d.]+/g)!.map(Number).slice(0, 3);
      const a = luminance(foreground), b = luminance(warningBackground);
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(contrast, `${sample.kind} against rendered warning background`).toBeGreaterThanOrEqual(4.5);
      return { kind: sample.kind, foreground: sample.foreground, contrast };
    });
    evidence.warningSurface = { background: warningBackground, tokenPaletteMatrix: warningMatrix,
      note: 'Actual warning banner background, compared with rendered token colors. Warning banners are plain prose; no current inline JSON owner uses this background.' };
    await page.screenshot({ path: join(directory, `${viewport.width}-system-page.png`) });

    await page.goto('/files?path=.saivage/work/irregular.json');
    const files = page.getByTestId('route-files');
    const fileBlock = files.locator('.code-block');
    await expect(fileBlock.locator('code')).toContainText('900719925474099312345');
    expect(await fileBlock.locator('code').textContent()).toBe(irregular);
    await copy(page, fileBlock, irregular);
    await capture('files-irregular', fileBlock);
    await expect(files).toContainText(/redact/i);
    await page.screenshot({ path: join(directory, `${viewport.width}-files-page.png`) });
    expect(await page.locator('.json-text img, .json-text script, .json-text a').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { jsonInjected?: boolean }).jsonInjected)).toBeUndefined();

    await page.goto('/files?path=.saivage/work/ordinary.log');
    await expect(files.locator('code')).toHaveText('{"ordinary log":true}\n');
    await expect(files.locator('.json-text, [class^="json-token-"]')).toHaveCount(0);
    await copy(page, files.locator('.code-block'), '{"ordinary log":true}\n');
    await page.screenshot({ path: join(directory, `${viewport.width}-plain-log.png`) });
    evidence.nonJsonLog = { exact: true, tokenCount: 0 };

    // One deliberate giant fixture per viewport exercises the real leaf cost bound;
    // it is not added to the ordinary shared smoke fixture data.
    await page.goto('/files?path=.saivage/work/oversized.json');
    const oversized = `"${'x'.repeat(1_000_000)}"`;
    await expect(files.locator('.highlighting-disabled')).toBeVisible();
    expect(await files.locator('code').textContent()).toBe(oversized);
    await expect(files.locator('.json-text > span')).toHaveCount(0);
    await copy(page, files.locator('.code-block'), oversized);
    await page.screenshot({ path: join(directory, `${viewport.width}-oversized-plain.png`) });
    evidence.oversized = { codeUnits: oversized.length, exactDisplayAndCopy: true, tokenCount: 0 };
    expect(errors).toEqual([]);
    expect(fixture.rest.unknown).toEqual([]);
    await writeFile(join(directory, `${viewport.width}-computed-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  });
}
