import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { startApp, type App } from '../../../src/boot/app.js';
import { readCard } from '../../../src/persistence/card-files.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import { nativeIdentity, nativeOptions, publicNativeCli, publicNativeProject, fixtureGit } from '../../helpers/public-native-project.js';
import { listen, closeServer, readJsonRequest, sendToolCall, sendFinalMessage } from '../../helpers/production-composition-e2e.js';
import { seedTokenBeforeNavigation } from './fixtures/operator-preview-sync.js';

test.describe.configure({ timeout: 480_000, retries: 0 });

for (const mode of ['delivery', 'correction', 'terminated'] as const) {
  test(`public native Git ${mode}: real server evidence in browser`, async ({ page }, testInfo) => {
    const root = publicNativeProject();
    const initialized = publicNativeCli(root, 'init', ...nativeOptions);
    expect(initialized.status, initialized.stderr).toBe(0);
    const initial = readCard(root, 'project')!.git!;
    const prior = Object.fromEntries(Object.keys(nativeIdentity).map(key => [key, process.env[key]]));
    Object.assign(process.env, nativeIdentity);
    let app: App | undefined, failure: unknown, correctionEntered = false, parentWaiting = false;
    let releaseParent!: () => void;
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    let releaseCorrection!: () => void;
    const correctionGate = new Promise<void>(resolve => { releaseCorrection = resolve; });
    const counts = new Map<string, number>();
    const apiEvidence: unknown[] = [];
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request);
        const role = body.model;
        const cardMessage = body.messages.find((m: any) => typeof m.content === 'string' && m.content.startsWith('{"cardId":'));
        const card = cardMessage ? JSON.parse(cardMessage.content).cardId : 'global';
        const nodeMessage = body.messages.find((m: any) => typeof m.content === 'string' && m.content.startsWith('Current workflow node '));
        const node = nodeMessage?.content.match(/^Current workflow node '([^']+)'/)?.[1] ?? 'global';
        const key = `${role}/${card}/${node}`, turn = (counts.get(key) ?? 0) + 1; counts.set(key, turn);
        const call = (name: string, args: object) => sendToolCall(response, `${key}-${turn}`, name, args);
        if (role === 'analyst') {
          if (turn === 1) return call('start_project', {});
          if (turn === 3) return call('queue_notification', { card_id: 'project', kind: 'browser-qualification', body: 'Queued evidence is not source acceptance.', urgency: 'normal' });
          return sendFinalMessage(response, 'Synthetic request settled.');
        }
        if (role === 'planner') {
          if (node === 'assess-completion') {
            if (turn === 1) return call('write', { path: 'record:///status.md?card=project', content: 'Finite browser delivery fixture fulfilled; source verified by test oracle.' });
            return call('emit_result', { outcome: 'complete_direct', summary: 'Finite synthetic delivery.' });
          }
          if (turn === 1) return call('create_card', { type: 'code', title: 'Original contribution', bootstrap_content: 'Change source.txt within this synthetic fixture.', priority: 0, urgency: 'normal', depends_on: [] });
          if (turn === 2) return call('activate_card', { card_id: 'card-a', instructions: 'Perform the bounded synthetic source change.' });
          if (mode === 'correction') {
            if (turn === 3) return call('create_card', { type: 'code', title: 'Parent advancement', bootstrap_content: 'Deliver a different source.txt value.', priority: 0, urgency: 'normal', depends_on: [] });
            if (turn === 4) return call('activate_card', { card_id: 'card-b', instructions: 'Deliver the parent advancement.' });
            if (turn === 5) return call('activate_card', { card_id: 'card-a', instructions: 'New parent input permits correction of the original contribution.' });
            if (turn === 6) { parentWaiting = true; await parentGate; return call('write', { path: 'record:///status.md?card=project', content: 'Correction remains incomplete; queued context does not approve source.' }); }
            return call('emit_result', { outcome: 'blocked', summary: 'Synthetic correction deliberately incomplete.' });
          }
          if (turn === 3) return call('write', { path: 'record:///status.md?card=project', content: 'Child source delivery complete; assess the finite objective.' });
          return call('emit_result', { outcome: 'assess_completion', summary: 'Assess finite delivery.' });
        }
        if (role !== 'executor') throw new Error(`Unexpected provider role ${role}`);
        if (node === 'git-rebase-correction') {
          if (turn === 1) {
            const facts = readCard(root, card)!.git!.correction!;
            return call('run_command', { command: `timeout -k 2s 25s bash -ec 'git rebase --merge --onto ${facts.onto.observed_tip} ${facts.base_oid} || test -d .git/rebase-merge; printf "partial resolution\\n" > source.txt'`, wait: true });
          }
          correctionEntered = true;
          await correctionGate;
          return call('emit_result', { outcome: 'blocked', summary: 'Partial source retained; original contribution remains to reconstruct.' });
        }
        if (turn === 1) return call('write', { path: 'source.txt', content: card === 'card-b' ? 'parent advancement\n' : 'original contribution\n' });
        if (mode === 'terminated' && turn === 2) {
          const hook = join(root, '.git/hooks/pre-commit');
          writeFileSync(hook, '#!/bin/sh\necho started > .saivage/browser-hook-started\nsleep 180\necho unexpected > .saivage/browser-hook-late\n');
          chmodSync(hook, 0o755);
          return call('checkpoint_source', {});
        }
        if (mode === 'terminated') throw new Error('Held source must not continue provider work');
        if (turn === 2) return call('write', { path: `record:///status.md?card=${card}`, content: `Synthetic ${card} source change; no unrelated acceptance.` });
        return call('emit_result', { outcome: mode === 'correction' && card === 'card-a' ? 'blocked' : 'done', summary: 'Bounded synthetic source result.' });
      } catch (error) { failure = error; response.statusCode = 500; response.end('Synthetic provider failed'); }
    });
    try {
      const port = await listen(provider);
      const configPath = join(root, '.saivage/saivage.yaml'), config = parse(readFileSync(configPath, 'utf8'));
      for (const agent of Object.values(config.agents) as any[]) agent.tools = agent.tools.filter((name: string) => name !== 'view_image');
      const roles = ['analyst', 'planner', 'executor', 'reviewer', 'oversight'];
      config.models = { routes: Object.fromEntries(roles.map(role => [role, { candidates: [role], temperature: 0, max_tokens: 512 }])), profiles: {}, equivalents: [], failover: {} };
      config.providers = { local: { models: roles, apiKey: 'synthetic-browser-provider', baseUrl: `http://127.0.0.1:${port}`, capabilities: { contextWindowTokens: 100000, maxOutputTokens: 16384 } } };
      config.compaction.summarizer_candidate = { provider: 'local', account: null, model: 'analyst' };
      writeFileSync(configPath, stringify(config));
      app = await startApp({ projectRoot: root, createRuntime: false, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', SAIVAGE_HOST: '127.0.0.1', SAIVAGE_PORT: '0', SAIVAGE_API_TOKEN: 'synthetic-native-browser' } });
      const origin = `http://127.0.0.1:${app.boundListener.port}`;
      const runtimeStatus = async () => {
        const response = await fetch(origin + '/api/runtime/status', { headers: { authorization: 'Bearer synthetic-native-browser' }, signal: AbortSignal.timeout(10_000) });
        expect(response.status).toBe(200); return (await response.json()).runtime;
      };
      const post = async (path: string, body?: object) => {
        const response = await fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer synthetic-native-browser', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
        const result = await response.json(); apiEvidence.push({ path, status: response.status, result }); expect(response.status).toBe(200); return result;
      };
      await seedTokenBeforeNavigation(page, 'synthetic-native-browser');
      await page.goto(`${origin}/cards/project`);
      await expect(page.getByTestId('overview-source')).toContainText('Native Git');
      await expect(page.getByTestId('overview-source')).toContainText(initial.observed_tip);
      await page.goto(`${origin}/cards/project?facet=executions`);
      await page.getByRole('button', { name: /Native Git commission.*native_started/ }).first().click();
      const detail = page.getByTestId('execution-detail');
      await expect(detail).toContainText('Initial project bootstrap (no activation)');
      await expect(detail).toContainText('commissioned');
      await expect(detail.locator('dt').filter({ hasText: /^Activation$/ })).toHaveCount(0);
      await expect(detail.locator('a[href*="agents/"]')).toHaveCount(0);
      await expect(detail).not.toContainText(root);
      await page.screenshot({ path: testInfo.outputPath('bootstrap.png'), fullPage: true });
      await post('/api/chat', { content: 'Start the finite synthetic browser fixture.' });
      if (mode === 'correction') {
        await expect.poll(() => { if (failure) throw failure; return correctionEntered; }, { timeout: 120_000 }).toBe(true);
        await page.goto(`${origin}/cards/card-a`);
        await expect(page.getByTestId('overview-source')).toContainText('Source correction required');
        await expect(page.getByTestId('overview-participants')).toContainText('executor');
        await page.goto(`${origin}/agents/${encodeURIComponent('agent:executor:card-a')}`);
        await expect(page.locator('body')).toContainText('git-rebase-correction');
        await page.screenshot({ path: testInfo.outputPath('correction.png'), fullPage: true });
        await post('/api/chat', { content: 'Queue the synthetic evidence note, without acceptance.' });
        expect(readCard(root, 'project')!.pending_notifications).toHaveLength(1);
        await page.goto(`${origin}/agents/${encodeURIComponent('agent:analyst:global')}`);
        const notification = page.getByRole('group', { name: 'tool queue_notification', exact: true });
        await notification.getByRole('button', { name: 'Expand tool queue_notification details', exact: true }).click();
        await notification.getByText('Safe original result', { exact: true }).click();
        await expect(notification).toContainText('queued');
        await expect(notification).toContainText('not_requested');
        await page.screenshot({ path: testInfo.outputPath('queued-not-delivered.png'), fullPage: true });
        releaseCorrection();
        await expect.poll(() => { if (failure) throw failure; return parentWaiting; }, { timeout: 120_000 }).toBe(true);
        await post('/api/runtime/pause'); releaseParent();
        await expect.poll(runtimeStatus, { timeout: 60_000 }).toBe('paused');
      }
      if (mode === 'delivery') await expect.poll(() => { if (failure) throw failure; return readCard(root, 'project')!.lifecycle.status; }, { timeout: 120_000 }).toBe('done');
      if (mode === 'terminated') await expect.poll(runtimeStatus, { timeout: 180_000 }).toBe('stopped');
      const card = mode === 'delivery' ? 'project' : 'card-a';
      await page.goto(`${origin}/cards/${card}?facet=executions`);
      // List is bounded; advance using the actual cursor until the requested step is present.
      const step = mode === 'delivery' ? 'deliver' : mode === 'correction' ? 'captureRebase' : 'checkpoint';
      const row = page.getByRole('button', { name: new RegExp(`Native Git ${step}.*native_started`) });
      for (let n = 0; n < 100 && await row.count() === 0; n++) {
        await page.getByRole('button', { name: 'More rows', exact: true }).click();
      }
      await row.first().click();
      await expect(detail).toContainText('Sequential native commands');
      expect(await detail.locator('pre').first().evaluate(element => getComputedStyle(element).color))
        .toBe(await detail.evaluate(element => getComputedStyle(element).color));
      await expect(detail).not.toContainText(root);
      await expect(detail).not.toContainText('synthetic-browser-provider');
      if (mode === 'delivery') {
        expect(fixtureGit(root, 'show', 'main:source.txt')).toBe('original contribution');
        expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('original contribution\n');
        await expect(detail).toContainText('returned');
        await page.goto(`${origin}/cards/project`);
        await expect(page.getByTestId('overview-source')).toContainText('Last completed delivery');
        await expect(page.getByTestId('overview-result-line')).toContainText('Finite synthetic delivery.');
        await page.getByText('Full recorded result and provenance (JSON)', { exact: true }).click();
        await expect(page.locator('.overview-result')).toContainText('planner');
      } else if (mode === 'correction') {
        expect(readCard(root, 'card-a')!.git!.correction!.preserved_source).not.toBeNull();
        expect(fixtureGit(root, 'show', 'main:source.txt')).toBe('delivery');
        await expect(detail).toContainText('captured');
        // Running-owner GC marks actual canonical bootstrap and sequential native
        // command evidence; no manufactured native rows or static capture list.
        const rows = ['project', 'card-a', 'card-b'].flatMap(id => readCardExecutions(root, id));
        const bootstrap = rows.find(row => row.kind === 'native_started' && row.binding.origin === 'bootstrap')!;
        expect(rows.filter(row => row.invocation_id === bootstrap.invocation_id && row.kind === 'native_process_started').length).toBeGreaterThan(1);
        const selected = new Set<string>();
        for (const row of rows) {
          if (row.kind === 'native_started') row.artifact_paths.forEach(path => selected.add(path));
          if (row.kind === 'native_process_started') row.files.forEach(file => selected.add(file.path));
        }
        expect([...selected].some(path => path.endsWith('/index'))).toBe(true);
        const digest = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
        const before = new Map([...selected].map(path => [path, digest(path)]));
        const garbage = join(root, '.saivage/work/cards/project/tmp/browser-unselected');
        mkdirSync(join(root, '.saivage/work/cards/project/tmp'), { recursive: true }); writeFileSync(garbage, 'disposable');
        const unlinked = join(root, '.saivage/cards/card-z/records'); mkdirSync(unlinked, { recursive: true });
        writeFileSync(join(unlinked, 'executions.jsonl'), 'Malformed unlinked bootstrap evidence must never be discovered.\n');
        const originalRef = readCard(root, 'card-a')!.git!.correction!.retained_original_ref;
        const originalOid = fixtureGit(root, 'rev-parse', originalRef);
        const gc = await post('/api/runtime/gc-work', { mode: 'delete', before: new Date(Date.now() + 1000).toISOString() });
        // Retained full-bundle prose conservatively protects all work. This
        // witnesses no effects, not selective marking (covered independently).
        expect(gc.disposition).toBe('completed'); expect(gc.result.deleted_count).toBe(0);
        expect(gc.result.retained.protected).toBe(gc.result.observed_count);
        expect(existsSync(garbage)).toBe(true);
        for (const [path, sha] of before) expect(digest(path), path).toBe(sha);
        expect(fixtureGit(root, 'rev-parse', originalRef)).toBe(originalOid);
        expect(existsSync(join(unlinked, 'executions.jsonl'))).toBe(true);
        await testInfo.attach('native-gc-selection', { body: JSON.stringify({ selected: [...before], gc }), contentType: 'application/json' });
        await post('/api/runtime/resume');
        await expect.poll(() => readCard(root, 'project')!.lifecycle.status, { timeout: 60_000 }).toBe('blocked');
      } else {
        // Containment leaves durable running selections; no logical finish may
        // be invented from command termination or stopped runtime alone.
        await expect(detail).toContainText('no completion retained; effects unknown');
        await expect(detail).toContainText('killed');
        await expect(detail).toContainText('deadline');
        expect(fixtureGit(root, 'show', 'main:source.txt')).toBe('delivery');
      }
      if (mode !== 'delivery') await page.getByTestId('card-executions').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`${mode}-result.png`), fullPage: true });
      expect(failure).toBeUndefined();
    } finally {
      releaseCorrection();
      releaseParent();
      await app?.stop(); await closeServer(provider);
      writeFileSync(join(root, '.saivage/browser-receipt.json'), JSON.stringify({ mode, root, failure: String(failure), counts: [...counts], apiEvidence, executions: readCardExecutions(root, 'project') }, null, 2));
      for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
  });
}
