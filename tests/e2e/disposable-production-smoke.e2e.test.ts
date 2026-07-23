import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { startApp, type App } from '../../src/boot/app.js';
import { saivageConfigSchema, type SaivageConfig } from '../../src/schemas/saivage-config.js';

const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TOKEN = 'disposable-e2e-token';
const roots: string[] = [];
const apps = new Set<App>();

type ChatMessage = { role: string; content: string; tool_call_id?: string };
type ChatRequest = {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
};

function toolNames(request: ChatRequest): string[] {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}

function toolCall(response: ServerResponse, id: number, name: string, args: object): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    choices: [{
      message: { content: null, tool_calls: [{ id: `call-${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    }],
  }));
}

function finalMessage(response: ServerResponse, content = 'done'): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

async function requestBody(request: IncomingMessage): Promise<ChatRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest;
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function runCli(root: string, command: 'init' | 'reset'): string {
  const result = spawnSync(process.execPath, [TSX, CLI, command], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: '' },
  });
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function testConfig(providerPort: number, appPort: number): SaivageConfig {
  const config = saivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
  config.server = { host: '127.0.0.1', port: appPort };
  config.models = {
    routes: {
      analyst: { candidates: ['analyst-model'], temperature: 0.2, max_tokens: 512 },
      planner: { candidates: ['planner-model'], temperature: 0.2, max_tokens: 512 },
      reviewer: { candidates: ['reviewer-model'], temperature: 0.2, max_tokens: 512 },
      executor: { candidates: ['executor-model'], temperature: 0.2, max_tokens: 512 },
    },
    profiles: {}, equivalents: [], failover: {},
  };
  config.providers = {
    fake: {
      models: ['analyst-model', 'planner-model', 'reviewer-model', 'executor-model'],
      apiKey: 'test-only', baseUrl: `http://127.0.0.1:${providerPort}`,
      capabilities: { contextWindowTokens: 100_000, maxOutputTokens: 16_384 },
    },
  };
  config.compaction = {
    ...config.compaction,
    input_budget_tokens: 32_768,
    summarizer_candidate: { provider: 'fake', account: null, model: 'analyst-model' },
  };
  config.card_types.code = {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', writers: ['analyst'], bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', writers: ['executor'], bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', writers: ['reviewer'], bootstrap: false },
    },
    workflow: {
      entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: 'stopped-recovery' } },
      nodes: {
        execute: {
          agent: 'executor', prompt: 'execute', correction_prompt: 'correct-execution-result', records: { 'status.md': 'updated' },
          edges: { verify: { target: { node: 'verify' }, prompt: 'execute-to-verify' } },
        },
        verify: {
          agent: 'reviewer', prompt: 'verify', correction_prompt: 'correct-verify-result', records: { 'status.md': 'present', 'review.md': 'updated' },
          edges: { approved: { target: { terminal: 'DONE', promote: { latest_node: 'execute' }, export_records: ['status.md', 'review.md'] } } },
        },
      },
    },
  };
  return config;
}

function writeCustomPrompts(root: string): void {
  const directory = join(root, '.saivage', 'config', 'prompts', 'code', 'process');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'execute-to-verify.md'), 'Execution accepted. Verify the closed status record.');
  writeFileSync(join(directory, 'verify.md'), 'Verify the completed work and publish review evidence.');
  writeFileSync(join(directory, 'correct-verify-result.md'), 'Correct the result and satisfy the declared record contract.');
}

async function start(root: string): Promise<App> {
  const app = await startApp({
    argv: ['node', 'saivage', 'start', '--project-root', root],
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', SAIVAGE_API_TOKEN: TOKEN },
  });
  apps.add(app);
  return app;
}

async function stop(app: App): Promise<void> {
  apps.delete(app);
  await app.stop();
}

function origin(app: App): string {
  return `http://127.0.0.1:${app.environment.server.port}`;
}

async function api(app: App, path: string, init: RequestInit = {}, authenticated = true): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin(app)}${path}`, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

async function chat(app: App, content: string): Promise<any> {
  const response = await api(app, '/api/chat', { method: 'POST', body: JSON.stringify({ content }) });
  if (response.status !== 200) {
    const errors = await api(app, '/api/debug/errors');
    throw new Error(`Analyst chat failed (${response.status}): ${JSON.stringify(response.body)} errors=${JSON.stringify(errors.body)}`);
  }
  return response.body;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

afterEach(async () => {
  for (const app of [...apps]) await stop(app);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('disposable production-composition smoke', () => {
  it('covers configured workflows, restart-only routing, recovery, and offline reset without retained state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-disposable-production-'));
    roots.push(root);
    const appPort = await unusedPort();
    let app: App | null = null;
    let analystPlan = 0;
    let oldPlannerCalls = 0;
    let recoveryPlannerCalls = 0;
    let executorCalls = 0;
    let reviewerCalls = 0;
    let oldPlannerBlocked = false;
    let oldPlannerRequestClosed = false;
    let activationToolResult = '';
    let rootStatusClosedBeforeReview = false;
    const offeredTools = new Map<string, string[]>();
    const requestedMaxTokens = new Map<string, number>();
    const providerUrls: string[] = [];
    const analystTools: Array<{ name: string; args: object }> = [
      { name: 'write', args: { path: 'record:///brief.md?card=project&v=next', content: 'Disposable Analyst bootstrap edit.' } },
      { name: 'create_card', args: { type: 'code', parent: 'project', title: 'Promoted child', bootstrap_content: 'Produce and review child evidence.', tags: [], priority: 0, urgency: 'normal', depends_on: [], related: [] } },
      { name: 'create_card', args: { type: 'goal', parent: 'card-a', title: 'Forbidden nested goal', bootstrap_content: 'Must be rejected by parent narrowing.', tags: [], priority: 0, urgency: 'normal', depends_on: [], related: [] } },
      { name: 'reconfigure', args: { action: 'set_agent_model_route', agent: 'planner', model_route: 'executor' } },
      { name: 'show_config', args: {} },
      { name: 'start_project', args: {} },
      { name: 'start_project', args: {} },
    ];

    const provider = createServer(async (request, response) => {
      providerUrls.push(request.url ?? '');
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
      const body = await requestBody(request);
      const names = toolNames(body);
      const last = body.messages.at(-1);
      const isAnalyst = names.includes('show_config');
      const isPlanner = names.includes('activate_card');
      const isExecutor = names.includes('run_command') && !isAnalyst;
      const agent = isAnalyst ? 'analyst' : isPlanner ? 'planner' : isExecutor ? 'executor' : 'reviewer';
      offeredTools.set(agent, names);
      requestedMaxTokens.set(agent, body.max_tokens);

      if (isAnalyst) {
        if (last?.role === 'tool') {
          finalMessage(response);
          return;
        }
        const planned = analystTools[analystPlan++];
        if (!planned) throw new Error('Unexpected Analyst provider request.');
        toolCall(response, analystPlan, planned.name, planned.args);
        return;
      }

      if (isPlanner && body.model === 'planner-model') {
        oldPlannerCalls += 1;
        if (oldPlannerCalls === 1) {
          toolCall(response, 100, 'write', { path: 'record:///status.md?v=next', content: 'Pre-restart open planning status.' });
          return;
        }
        oldPlannerBlocked = true;
        response.once('close', () => { oldPlannerRequestClosed = true; });
        return;
      }

      if (isPlanner && body.model === 'executor-model') {
        recoveryPlannerCalls += 1;
        if (recoveryPlannerCalls === 1) {
          toolCall(response, 200, 'write', { path: 'record:///status.md?v=next', content: 'Recovered plan with closed child evidence.' });
        } else if (recoveryPlannerCalls === 2) {
          toolCall(response, 201, 'activate_card', { card_id: 'card-a' });
        } else if (recoveryPlannerCalls === 3) {
          activationToolResult = last?.content ?? '';
          toolCall(response, 202, 'emit_result', { outcome: 'admit_review', summary: 'Parent submits after promoted child completion.' });
        } else throw new Error(`Unexpected recovery Planner call ${recoveryPlannerCalls}.`);
        return;
      }

      if (isExecutor) {
        executorCalls += 1;
        if (executorCalls === 1) toolCall(response, 300, 'write', { path: 'record:///status.md?v=next', content: 'Ordered child status export.' });
        else if (executorCalls === 2) toolCall(response, 301, 'emit_result', { outcome: 'verify', summary: 'Promoted executor summary.' });
        else throw new Error(`Unexpected Executor call ${executorCalls}.`);
        return;
      }

      reviewerCalls += 1;
      if (reviewerCalls === 1) toolCall(response, 400, 'write', { path: 'record:///review.md?v=next', content: 'Child review export.' });
      else if (reviewerCalls === 2) toolCall(response, 401, 'emit_result', { outcome: 'approved', summary: 'Verifier summary must not be promoted.' });
      else if (reviewerCalls === 3) {
        const cards = app!.server.runtimeApplication.cardStore;
        rootStatusClosedBeforeReview = cards.readRecord('project', 'status.md', 'latest').artifact.content === 'Recovered plan with closed child evidence.';
        toolCall(response, 402, 'write', { path: 'record:///review.md?v=next', content: 'Root review after closed plan status.' });
      } else if (reviewerCalls === 4) toolCall(response, 403, 'emit_result', { outcome: 'approved', summary: 'Root review approved.' });
      else throw new Error(`Unexpected Reviewer call ${reviewerCalls}.`);
    });
    const providerPort = await listen(provider);

    try {
      expect(runCli(root, 'init')).toContain('Project initialized');
      expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'card.jsonl'), 'utf8')).toContain('"id":"project"');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(testConfig(providerPort, appPort)));
      writeCustomPrompts(root);

      app = await start(root);
      expect((await api(app, '/api/debug/graphs', {}, false)).status).toBe(401);
      const firstGraphs = await api(app, '/api/debug/graphs');
      expect(firstGraphs.status).toBe(200);
      const projectGraph = firstGraphs.body.graphs.find((graph: any) => graph.card_type === 'project');
      const codeGraph = firstGraphs.body.graphs.find((graph: any) => graph.card_type === 'code');
      expect(projectGraph.nodes.find((node: any) => node.node_id === 'plan').model.route).toBe('planner');
      expect(codeGraph.edges.find((edge: any) => edge.outcome === 'approved')).toMatchObject({
        export_records: ['status.md', 'review.md'], promotion: { kind: 'latest-node', node_id: 'execute' },
      });
      expect(projectGraph.nodes.find((node: any) => node.agent_name === 'reviewer').tools).not.toContain('mcp_tool_call');

      const edited = await chat(app, 'Edit the root bootstrap record.');
      if (!edited.toolInvocations?.[0]) {
        const conversation = await api(app, '/api/chat');
        throw new Error(`Missing Analyst tool invocation: ${JSON.stringify(edited)} conversation=${JSON.stringify(conversation.body)} urls=${JSON.stringify(providerUrls)} offered=${JSON.stringify([...offeredTools])} counts=${JSON.stringify({ analystPlan, executorCalls, reviewerCalls })}`);
      }
      expect(edited.toolInvocations[0].result.success).toBe(true);
      expect(app.server.runtimeApplication.cardStore.readRecord('project', 'brief.md', 'latest').artifact.content).toBe('Disposable Analyst bootstrap edit.');
      await chat(app, 'Create the permitted code child under project.');
      expect(app.server.runtimeApplication.cardStore.read('card-a')).toMatchObject({ type: 'code', lifecycle: { status: 'backlog' } });
      const narrowed = await chat(app, 'Attempt a goal under the code parent; it must be narrowed away.');
      expect(narrowed.toolInvocations[0].result.error).toContain("child type 'goal' is not permitted under 'code'");

      const changed = await chat(app, 'Change Planner to the Executor model route for the next restart.');
      expect(changed.toolInvocations[0].result.data.requires_restart).toBe(true);
      const shown = await chat(app, 'Show the next-start configuration.');
      expect(shown.toolInvocations[0].result.data.config.agents.planner.model_route).toBe('executor');
      const unchangedGraphs = await api(app, '/api/debug/graphs');
      expect(unchangedGraphs.body.graphs.find((graph: any) => graph.card_type === 'project').nodes.find((node: any) => node.node_id === 'plan').model.route).toBe('planner');

      const started = await chat(app, 'Start the project with the current startup artifact.');
      expect(started.toolInvocations[0].result).toMatchObject({ success: true });
      try { await waitUntil(() => oldPlannerBlocked, 'the current Planner invocation'); }
      catch { throw new Error(`Planner did not block: ${JSON.stringify({ oldPlannerCalls, recoveryPlannerCalls, executorCalls, reviewerCalls, providerUrls, offered: [...offeredTools], runtime: app.server.runtimeApplication.runtimeApi.getStatus(), card: app.server.runtimeApplication.cardStore.read('project')?.lifecycle })}`); }
      expect(oldPlannerCalls).toBe(2);
      expect(requestedMaxTokens.get('planner')).toBe(512);
      expect(app.server.runtimeApplication.cardStore.read('project')?.lifecycle.status).toBe('running');
      const stopped = await api(app, '/api/runtime/stop-project', { method: 'POST' });
      expect(stopped.status).toBe(200);
      await waitUntil(() => oldPlannerRequestClosed, 'the stopped provider request to close');
      expect(app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
      expect(app.server.runtimeApplication.cardStore.read('project')?.lifecycle.status).toBe('running');
      await stop(app);
      app = null;

      app = await start(root);
      const restartedGraphs = await api(app, '/api/debug/graphs');
      expect(restartedGraphs.body.graphs.find((graph: any) => graph.card_type === 'project').nodes.find((node: any) => node.node_id === 'recover').model.route).toBe('executor');
      await chat(app, 'Recover and start the stopped project.');
      await waitUntil(() => app!.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped', 'recovered workflow completion');

      expect(recoveryPlannerCalls).toBe(3);
      expect(executorCalls).toBe(2);
      expect(reviewerCalls).toBe(4);
      expect(rootStatusClosedBeforeReview).toBe(true);
      const activation = JSON.parse(activationToolResult);
      expect(activation).toMatchObject({ success: true, data: { outcome: 'done', summary: 'Promoted executor summary.' } });
      expect(activation.data.result).toMatchObject({ agent_name: 'executor', node_id: 'execute', summary: 'Promoted executor summary.' });
      expect(activation.data.result.records.map((record: any) => record.name)).toEqual(['status.md', 'review.md']);
      expect(app.server.runtimeApplication.cardStore.read('card-a')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Promoted executor summary.' } } });
      expect(app.server.runtimeApplication.cardStore.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Root review approved.' } } });

      expect(offeredTools.get('analyst')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.analyst.tools);
      expect(offeredTools.get('planner')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.planner.tools.concat('emit_result'));
      expect(offeredTools.get('executor')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.executor.tools.concat('emit_result'));
      expect(offeredTools.get('reviewer')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.reviewer.tools.concat('emit_result'));
      expect(offeredTools.get('reviewer')).not.toContain('mcp_tool_call');

      await stop(app);
      app = null;
      expect(runCli(root, 'reset')).toContain('Project reset with a new root project card');
      expect(runCli(root, 'init')).toContain('Project already initialized');
      const resetConfig = readFileSync(join(root, '.saivage', 'saivage.yaml'), 'utf8');
      expect(resetConfig).toContain('model_route: executor');
      expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'card.jsonl'), 'utf8')).toContain('"status":"backlog"');
      expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'brief.jsonl'), 'utf8')).toContain('runtime:bootstrap');
    } finally {
      if (app) await stop(app);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 90_000);
});
