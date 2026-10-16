import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  productionTestConfig, readJsonRequest, sendFinalMessage, sendToolCall,
  startProductionApp, writeProductionConfig, type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'workspace-search-scope-e2e-token';
const roots: string[] = [];
const apps = new Set<App>();

afterEach(async () => {
  for (const app of [...apps]) await app.stop();
  apps.clear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function resultOf(request: ChatCompletionRequest): { success: boolean; data?: Record<string, any>; error?: string } {
  const message = request.messages.at(-1);
  if (message?.role !== 'tool') throw new Error('Expected a provider continuation ending in a tool result.');
  return JSON.parse(message.content) as { success: boolean; data?: Record<string, any>; error?: string };
}

describe('workspace search scope production composition', () => {
  it('delivers sibling pagination and reusable absolute paths to the scripted Analyst, with private provider and stored results', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'saivage-absolute-read-e2e-')); roots.push(parent);
    const projectRoot = join(parent, 'project'); const sibling = join(parent, 'sibling');
    mkdirSync(projectRoot); mkdirSync(sibling); initializeProject(projectRoot);
    const sentinel = 'ghp_SYNTHETIC_ABSOLUTE_READ_E2E_SENTINEL';
    const privateSentinel = 'synthetic-private-file-must-not-be-read';
    for (const name of ['a.txt', 'b.txt']) writeFileSync(join(sibling, name), `needle ${name} ${sentinel}`);
    writeFileSync(join(sibling, '.env'), privateSentinel);
    type Step = { tool: string; args: Record<string, unknown>; check: (result: ReturnType<typeof resultOf>) => void };
    const seen: string[] = [];
    const steps: Step[] = [];
    const expectRead = (path: string): Step => ({ tool: 'read', args: { path }, check: (result) => {
      expect(result.success).toBe(true); expect(result.data?.path).toBe(path);
      expect(result.data?.content.content).toContain('needle');
    } });
    const discover = (tool: 'glob' | 'grep', position?: unknown): Step => ({
      tool, args: { ...(tool === 'glob' ? { directory: sibling, pattern: '*.txt' } : { path: sibling, pattern: 'needle' }), max_results: 1, ...(position ? { position } : {}) },
      check: (result) => {
        expect(result.success).toBe(true); expect(result.data?.matches.total).toBe(2);
        const item = result.data!.matches.items[0]; const path = tool === 'glob' ? item : item.path;
        seen.push(path);
        if (result.data!.matches.next) steps.unshift(discover(tool, result.data!.matches.next));
        steps.unshift(expectRead(path));
      },
    });
    steps.push(expectRead(join(sibling, 'a.txt')), discover('glob'), discover('grep'), {
      tool: 'read', args: { path: join(sibling, '.env') }, check: (result) => { expect(result.success).toBe(false); },
    }, {
      tool: 'read', args: { path: join(sibling, `${sentinel}.missing`) }, check: (result) => { expect(result.success).toBe(false); },
    });
    let pending: Step | undefined; let fixtureFailure: Error | null = null; let calls = 0;
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        // Check settled tool messages, not the provider's own literal call arguments.
        const toolMessages = body.messages.filter((message) => message.role === 'tool');
        expect(JSON.stringify(toolMessages)).not.toContain(sentinel);
        expect(JSON.stringify(toolMessages)).not.toContain(privateSentinel);
        expect(offeredToolNames(body)).toEqual(expect.arrayContaining(['read', 'glob', 'grep']));
        if (pending) pending.check(resultOf(body));
        pending = steps.shift(); calls += 1;
        if (pending) sendToolCall(response, `external-${calls}`, pending.tool, pending.args);
        else sendFinalMessage(response, 'Absolute inspection verified.');
      } catch (error) { fixtureFailure = error as Error; sendFinalMessage(response, 'Fixture assertion failed.'); }
    });
    const providerPort = await listen(provider); let app: App | null = null;
    try {
      writeProductionConfig(projectRoot, productionTestConfig(providerPort));
      app = await startProductionApp(projectRoot, TOKEN); apps.add(app);
      const response = await fetch(`${appOrigin(app)}/api/chat`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Inspect the ordinary sibling files.' }),
      });
      expect(response.status).toBe(200); await response.json();
      if (fixtureFailure) throw fixtureFailure;
      expect(calls).toBe(12);
      expect(seen).toEqual([join(sibling, 'a.txt'), join(sibling, 'b.txt'), join(sibling, 'a.txt'), join(sibling, 'b.txt')]);
      const results = readConversation(projectRoot, 'agent:analyst:global').physicalRows.filter((row) => row.kind === 'tool_result');
      expect(results).toHaveLength(11);
      expect(JSON.stringify(results)).not.toContain(sentinel);
      expect(JSON.stringify(results)).not.toContain(privateSentinel);
      expect(JSON.stringify(results)).toContain('[REDACTED]');
    } finally {
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider);
    }
  }, 60_000);

  it('filters real Analyst project searches while retaining fixtures and explicit reads', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-search-scope-e2e-'));
    roots.push(projectRoot);
    const observed: Array<{ tool: string; result: ReturnType<typeof resultOf> }> = [];
    let calls = 0;
    let fixtureFailure: Error | null = null;

    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected provider URL '${request.url}'.`);
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        const tools = offeredToolNames(body);
        if (!tools.includes('glob') || !tools.includes('grep') || !tools.includes('read')) throw new Error(`Unexpected Analyst tools: ${tools.join(',')}.`);
        calls += 1;
        if (calls === 1) {
          sendToolCall(response, 'glob-project-relative', 'glob', { directory: '.', pattern: '**/*.txt' });
        } else if (calls === 2) {
          observed.push({ tool: 'glob', result: resultOf(body) });
          sendToolCall(response, 'grep-project-url', 'grep', { path: 'project:///', pattern: 'scope-e2e-needle' });
        } else if (calls === 3) {
          observed.push({ tool: 'grep', result: resultOf(body) });
          sendToolCall(response, 'read-excluded-file', 'read', { path: 'artifacts/prior-runs/stale.txt' });
        } else if (calls === 4) {
          observed.push({ tool: 'read', result: resultOf(body) });
          sendFinalMessage(response, 'Search scope verified.');
        } else throw new Error(`Unexpected Analyst request ${calls}.`);
      } catch (error) {
        fixtureFailure = error as Error;
        response.statusCode = 500;
        response.end();
      }
    });
    const providerPort = await listen(provider);
    let app: App | null = null;
    try {
      initializeProject(projectRoot);
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      mkdirSync(join(projectRoot, 'artifacts', 'fixtures'), { recursive: true });
      mkdirSync(join(projectRoot, 'artifacts', 'prior-runs'), { recursive: true });
      writeFileSync(join(projectRoot, '.saivage-search-ignore'), 'artifacts/prior-runs\n');
      writeFileSync(join(projectRoot, 'src', 'current.txt'), 'scope-e2e-needle current');
      writeFileSync(join(projectRoot, 'artifacts', 'fixtures', 'required.txt'), 'scope-e2e-needle required fixture');
      writeFileSync(join(projectRoot, 'artifacts', 'prior-runs', 'stale.txt'), 'scope-e2e-needle stale output');
      writeProductionConfig(projectRoot, productionTestConfig(providerPort));
      app = await startProductionApp(projectRoot, TOKEN);
      apps.add(app);

      const response = await fetch(`${appOrigin(app)}/api/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Inspect the project search scope.' }),
      });
      expect(response.status).toBe(200);
      await response.json();
      if (fixtureFailure) throw fixtureFailure;
      expect(calls).toBe(4);

      expect(observed).toHaveLength(3);
      const glob = observed[0]!.result;
      expect(glob.success).toBe(true);
      expect(glob.data?.matches.items).toEqual(expect.arrayContaining(['src/current.txt', 'artifacts/fixtures/required.txt']));
      expect(JSON.stringify(glob)).not.toContain('artifacts/prior-runs/stale.txt');
      const grep = observed[1]!.result;
      expect(grep.success).toBe(true);
      expect(grep.data?.matches.items.map((match: { path: string }) => match.path)).toEqual(['artifacts/fixtures/required.txt', 'src/current.txt']);
      expect(JSON.stringify(grep)).not.toContain('stale output');
      const read = observed[2]!.result;
      expect(read.success).toBe(true);
      expect(read.data?.path).toBe('artifacts/prior-runs/stale.txt');
      expect(read.data?.content.content).toBe('scope-e2e-needle stale output');
    } finally {
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider);
    }
  }, 60_000);
});
