import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { startApp, type App } from '../../src/boot/app.js';
import { effectiveSaivageConfigSchema, type SaivageConfig } from '../../src/schemas/saivage-config.js';
import { readConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { providerExchangeFile } from '../../src/persistence/layout.js';
import { readCommittedCardCurrent } from '../../src/persistence/card-files.js';
import { CardService } from '../helpers/canonical-project.js';

const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TOKEN = 'disposable-e2e-token';
const roots: string[] = [];
const apps = new Set<App>();

type ChatMessage = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};
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
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' };
  delete env.SAIVAGE_API_TOKEN;
  const result = spawnSync(process.execPath, [TSX, CLI, command], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function testConfig(providerPort: number, appPort: number): SaivageConfig {
  const config = effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));
  config.server = { host: '127.0.0.1', port: appPort };
  config.models = {
    routes: {
      analyst: { candidates: ['analyst-model'], temperature: 0.2, max_tokens: 512 },
      oversight: { candidates: ['oversight-model'], temperature: 0.2, max_tokens: 512 },
      planner: { candidates: ['planner-model'], temperature: 0.2, max_tokens: 512 },
      reviewer: { candidates: ['reviewer-model'], temperature: 0.2, max_tokens: 512 },
      executor: { candidates: ['executor-model'], temperature: 0.2, max_tokens: 512 },
    },
    profiles: {}, equivalents: [], failover: {},
  };
  config.providers = {
    fake: {
      models: ['analyst-model', 'oversight-model', 'planner-model', 'reviewer-model', 'executor-model'],
      apiKey: 'test-only', baseUrl: `http://127.0.0.1:${providerPort}`,
      capabilities: { contextWindowTokens: 25_000, maxOutputTokens: 16_384 },
    },
  };
  config.compaction = {
    ...config.compaction,
    context_utilization_fraction: 0.8,
    summarizer_candidate: { provider: 'fake', account: null, model: 'analyst-model' },
  };
  config.agents.reviewer!.record_writes=['status.md','review.md','review-*.md'];
  config.card_types.code = {
    permitted_child_types: [],
    records: {
      'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
      'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
      'review.md': { format: 'markdown', schema: 'work-review.v1', bootstrap: false },
    },
    workflow: {
      notification_recipient: 'executor',
      entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
      nodes: {
        execute: {
          agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: { 'status.md': {mode:'continue',gate:'updated'} },
          edges: { verify: { target: { node: 'verify' }, prompt: { reference: 'execute-to-verify', compactable: true } } },
        },
        verify: {
          agent: 'reviewer', prompt: { reference: 'verify', compactable: true }, correction_prompt: { reference: 'correct-verify-result', compactable: true }, records: { 'status.md': {mode:'continue',gate:'exists'}, 'review.md': {mode:'clean',gate:'updated'} },
          edges: { approved: { target: { terminal: 'DONE', promote: { latest_node: 'execute' }, export_records: ['status.md', 'review.md'] }, pending_notifications: { node: 'execute', prompt: { reference: 'review-notifications-to-execute', compactable: true } } } },
        },
      },
    },
  };
  return config;
}

function writeCustomPrompts(root: string): void {
  const directory = join(root, '.saivage', 'config', 'prompts', 'process', 'code');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'execute-to-verify.md'), 'Execution accepted. Verify the closed status record.');
  writeFileSync(join(directory, 'verify.md'), 'Verify the completed work and publish review evidence.');
  writeFileSync(join(directory, 'correct-verify-result.md'), 'Correct the result and satisfy the declared record contract.');
  writeFileSync(join(directory, 'review-notifications-to-execute.md'), 'Accepted review remains evidence. Reconsider the newly delivered context, update the work when warranted, and repeat verification before completion.');
}

async function start(root: string): Promise<App> {
  const app = await startApp({
    projectRoot: root, createRuntime: false,
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
    headers: { connection: 'close', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
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
  it('settles an in-scope Planner self-notification with a pending matched result before root replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-self-notice-e2e-'));
    roots.push(root);
    const appPort = await unusedPort();
    let app: App | null = null;
    let plannerCalls = 0;
    let replacementInput = '';
    const provider = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
      const body = await requestBody(request);
      if (toolNames(body).includes('show_config')) {
        if (body.messages.at(-1)?.role === 'tool') finalMessage(response);
        else toolCall(response, 1, 'start_project', {});
      } else if (body.model === 'planner-model') {
        plannerCalls++;
        if (plannerCalls === 1) toolCall(response, 101, 'queue_notification', { card_id: 'project', kind: 'correction', body: 'planner self correction', urgency: 'urgent' });
        if (plannerCalls === 2) replacementInput = JSON.stringify(body.messages);
      }
    });
    const providerPort = await listen(provider);
    try {
      runCli(root, 'init');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(testConfig(providerPort, appPort)));
      writeCustomPrompts(root);
      app = await start(root);
      expect((await chat(app, 'Start project work.')).toolInvocations[0].result).toMatchObject({ success: true });
      await waitUntil(() => plannerCalls === 2, 'replacement after Planner self-notification');
      const rows = readConversation(root, 'agent:planner:project').sourceRows;
      expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-101')).toHaveLength(1);
      const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-101');
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toContain('pending_tool_settlement');
      expect(results[0]!.content).toContain('"queued":true');
      expect(replacementInput).toContain('planner self correction');
      const versions = app.server.runtimeApplication.cardStore.listCardVersions('project');
      if (versions.kind !== 'found') throw new Error('Missing root versions.');
      expect(versions.value.map((version) => version.change?.change_reason).filter((reason) => reason === 'recovery stopped lifecycle' || reason === 'STOPPED activation')).toEqual(['recovery stopped lifecycle', 'STOPPED activation']);
      expect((await api(app, '/api/runtime/stop-project', { method: 'POST' })).status).toBe(200);
    } finally {
      if (app) await stop(app);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 60000);

  it.each([true, false])('routes a queued inactive branch by parent judgment (willing=%s)', async (willing) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-inactive-notice-e2e-'));
    roots.push(root);
    const appPort = await unusedPort();
    let app: App | null = null;
    let analystCalls = 0;
    let plannerCalls = 0;
    let executorCalls = 0;
    let rootInput = '';
    let goalInput = '';
    let leafInput = '';
    const analystTools = [
      { name: 'create_card', args: { type: 'goal', parent: 'project', title: 'Inactive goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', depends_on: [] } },
      { name: 'create_card', args: { type: 'code', parent: 'card-a', title: 'Inactive leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', depends_on: [] } },
      { name: 'queue_notification', args: { card_id: 'card-a-a', kind: 'correction', body: 'queued inactive leaf', urgency: 'urgent' } },
      { name: 'start_project', args: {} },
    ];
    const provider = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
      const body = await requestBody(request);
      if (toolNames(body).includes('show_config')) {
        if (body.messages.at(-1)?.role === 'tool') { finalMessage(response); return; }
        const action = analystTools[analystCalls++];
        if (!action) throw new Error('Unexpected Analyst call.');
        toolCall(response, analystCalls, action.name, action.args);
      } else if (body.model === 'planner-model') {
        plannerCalls++;
        if (plannerCalls === 1) {
          rootInput = JSON.stringify(body.messages);
          if (willing) toolCall(response, 101, 'activate_card', { card_id: 'card-a' });
          else toolCall(response, 101, 'write', { path: 'record:///status.md?card=project', content: 'Decline to activate inactive branch.' });
        } else if (!willing && plannerCalls === 2) {
          toolCall(response, 102, 'emit_result', { outcome: 'failed', summary: 'Declined inactive branch.' });
        } else if (willing && plannerCalls === 2) {
          goalInput = JSON.stringify(body.messages);
          toolCall(response, 102, 'activate_card', { card_id: 'card-a-a' });
        }
      } else if (body.model === 'executor-model') {
        executorCalls++;
        leafInput = JSON.stringify(body.messages);
      }
    });
    const providerPort = await listen(provider);
    try {
      runCli(root, 'init');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(testConfig(providerPort, appPort)));
      writeCustomPrompts(root);
      app = await start(root);
      expect((await chat(app, 'Create the goal.')).toolInvocations[0].result).toMatchObject({ success: true });
      expect((await chat(app, 'Create its leaf.')).toolInvocations[0].result).toMatchObject({ success: true });
      const queued = await chat(app, 'Urgently notify the inactive leaf.');
      expect(queued.toolInvocations[0].result).toMatchObject({ success: true, data: { queued: true, interruption: { status: 'not_applicable' } } });
      expect(plannerCalls).toBe(0);
      expect(app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
      expect((await chat(app, 'Start the queued project.')).toolInvocations[0].result).toMatchObject({ success: true });
      await waitUntil(() => willing ? executorCalls === 1 : app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'failed', 'parent branch decision');
      expect(rootInput).toContain("descendant 'card-a-a' needs attention through immediate child 'card-a'");
      const rootRows = readConversation(root, 'agent:planner:project').sourceRows;
      expect(rootRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-101')).toHaveLength(1);
      expect(rootRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-101')).toHaveLength(willing ? 0 : 1);
      if (willing) {
        expect(goalInput).toContain("descendant 'card-a-a' needs attention through immediate child 'card-a-a'");
        expect(leafInput).toContain('queued inactive leaf');
        const goalRows = readConversation(root, 'agent:planner:card-a').sourceRows;
        expect(goalRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-102')).toHaveLength(1);
        expect(goalRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-102')).toHaveLength(0);
        expect(app.server.runtimeApplication.cardStore.read('card-a-a')?.lifecycle.status).toBe('running');
      } else {
        expect(goalInput).toBe('');
        expect(executorCalls).toBe(0);
        expect(app.server.runtimeApplication.cardStore.read('project')?.lifecycle.status).toBe('failed');
        expect(app.server.runtimeApplication.cardStore.read('card-a-a')?.lifecycle.status).toBe('backlog');
        expect(app.server.runtimeApplication.cardStore.read('card-a-a')?.pending_notifications).toHaveLength(1);
      }
      expect((await api(app, '/api/runtime/stop-project', { method: 'POST' })).status).toBe(200);
    } finally {
      if (app) await stop(app);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 60000);

  it('redispatches an urgently stopped active leaf only when its real parent elects activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-urgent-leaf-e2e-'));
    roots.push(root);
    const appPort = await unusedPort();
    let app: App | null = null;
    let analystCalls = 0;
    let plannerCalls = 0;
    let executorCalls = 0;
    let parentInput = '';
    let resumedInput = '';
    const analystTools = [
      { name: 'create_card', args: { type: 'code', parent: 'project', title: 'Active child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', depends_on: [] } },
      { name: 'start_project', args: {} },
      { name: 'queue_notification', args: { card_id: 'card-a', kind: 'correction', body: 'urgent leaf correction', urgency: 'urgent' } },
    ];
    const provider = createServer(async (request, response) => {
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
      const body = await requestBody(request);
      if (toolNames(body).includes('show_config')) {
        if (body.messages.at(-1)?.role === 'tool') { finalMessage(response); return; }
        const action = analystTools[analystCalls++];
        if (!action) throw new Error('Unexpected Analyst call.');
        toolCall(response, analystCalls, action.name, action.args);
      } else if (body.model === 'planner-model') {
        plannerCalls++;
        if (plannerCalls === 2) parentInput = JSON.stringify(body.messages);
        if (plannerCalls <= 2) toolCall(response, 100 + plannerCalls, 'activate_card', { card_id: 'card-a' });
      } else if (body.model === 'executor-model') {
        executorCalls++;
        if (executorCalls === 2) resumedInput = JSON.stringify(body.messages);
      }
    });
    const providerPort = await listen(provider);
    try {
      runCli(root, 'init');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(testConfig(providerPort, appPort)));
      writeCustomPrompts(root);
      app = await start(root);
      expect((await chat(app, 'Create the code child.')).toolInvocations[0].result).toMatchObject({ success: true });
      expect((await chat(app, 'Start project work.')).toolInvocations[0].result).toMatchObject({ success: true });
      await waitUntil(() => executorCalls === 1, 'active child provider request');
      const urgent = await chat(app, 'Urgently notify the child.');
      expect(urgent.toolInvocations[0].result).toMatchObject({ success: true, data: { queued: true, interruption: { status: 'interrupted', stopped_card_ids: ['card-a'] } } });
      await waitUntil(() => executorCalls === 2, 'redispatched child recipient');
      expect(parentInput).toContain("immediate child 'card-a'");
      expect(resumedInput).toContain('urgent leaf correction');
      const parentRows = readConversation(root, 'agent:planner:project').sourceRows;
      expect(parentRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-101')).toHaveLength(1);
      expect(parentRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-101')).toHaveLength(1);
      expect(parentRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-102')).toHaveLength(1);
      expect(app.server.runtimeApplication.cardStore.read('card-a')?.lifecycle.status).toBe('running');
      expect((await api(app, '/api/runtime/stop-project', { method: 'POST' })).status).toBe(200);
    } finally {
      if (app) await stop(app);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 60000);

  it('queues normal steering while running and replaces an urgent root through real Analyst/server/provider paths', async () => {
    const root=mkdtempSync(join(tmpdir(),'saivage-notification-server-e2e-'));
    roots.push(root);
    const appPort=await unusedPort();
    let app:App|null=null;
    let analystCalls=0;
    let plannerCalls=0;
    let replacementInput='';
    const provider=createServer(async(request,response)=>{
      if(request.url!=='/v1/chat/completions'){response.statusCode=404;response.end();return;}
      const body=await requestBody(request);
      if(toolNames(body).includes('show_config')){
        if(body.messages.at(-1)?.role==='tool'){finalMessage(response);return;}
        analystCalls++;
        if(analystCalls===1)toolCall(response,analystCalls,'start_project',{});
        else toolCall(response,analystCalls,'queue_notification',{card_id:'project',kind:'correction',body:analystCalls===2?'normal steering':'urgent root steering',urgency:analystCalls===2?'normal':'urgent'});
        return;
      }
      plannerCalls++;
      if(plannerCalls===2){replacementInput=JSON.stringify(body.messages);}
    });
    const providerPort=await listen(provider);
    try{
      expect(runCli(root,'init')).toContain('Configuration materialized from template classic');
      writeFileSync(join(root,'.saivage','saivage.yaml'),stringify(testConfig(providerPort,appPort)));
      writeCustomPrompts(root);
      app=await start(root);
      expect((await chat(app,'Start project work.')).toolInvocations[0].result.success).toBe(true);
      await waitUntil(()=>plannerCalls===1,'initial live root provider request');
      const normal=await chat(app,'Queue ordinary root context while running.');
      expect(normal.toolInvocations[0].result).toMatchObject({success:true,data:{queued:true,interruption:{status:'not_requested'}}});
      expect(app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('running');
      const urgent=await chat(app,'Urgently interrupt the current root work.');
      expect(urgent.toolInvocations[0].result).toMatchObject({success:true,data:{queued:true,interruption:{status:'interrupted',stopped_card_ids:['project']}}});
      await waitUntil(()=>plannerCalls===2,'replacement root provider request');
      expect(replacementInput).toContain('normal steering');
      expect(replacementInput).toContain('urgent root steering');
      expect(app.server.runtimeApplication.cardStore.read('project')?.lifecycle.status).toBe('running');
      const rows=app.server.runtimeApplication.cardStore.listCardVersions('project');
      if(rows.kind!=='found')throw new Error('Missing root version history.');
      const reasons=rows.value.map((version)=>version.change?.change_reason);
      expect(reasons.filter((reason)=>reason==='recovery stopped lifecycle'||reason==='STOPPED activation')).toEqual(['recovery stopped lifecycle','STOPPED activation']);
      expect((await api(app,'/api/runtime/stop-project',{method:'POST'})).status).toBe(200);
    }finally{
      if(app)await stop(app);
      await new Promise<void>((resolve)=>provider.close(()=>resolve()));
    }
  },60000);
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
    let summaryCalls = 0;
    let oldPlannerBlocked = false;
    let oldPlannerRequestClosed = false;
    let activationToolResult = '';
    let rootStatusClosedBeforeReview = false;
    const offeredTools = new Map<string, string[]>();
    const requestedMaxTokens = new Map<string, number>();
    const providerUrls: string[] = [];
    const summaryRequests: ChatRequest[] = [];
    const summaryExecutorCounts: number[] = [];
    let originalExecutorConversation: ReturnType<typeof readConversation> | undefined;
    let publishedExecutorSegment: ReturnType<typeof readCurrentConversationSegment> = null;
    let continuedExecutorSegment: ReturnType<typeof readCurrentConversationSegment> = null;
    let publishedExecutorRequest: ChatRequest | undefined;
    let continuedExecutorRequest: ChatRequest | undefined;
    let summaryCallsBeforeC = 0;
    const sourceA = `Unresolved task: finish card-a verification. Constraint: preserve exact admission. Decision: continue without replay. Exact identifier: record:///status.md?card=card-a. Next action: read the second source. ${'X'.repeat(31_000)}`;
    const sourceB = `Refreshed unresolved task from the second observation. Constraint: never replay prior effects. Decision: use the new observation. Exact identifier: card-a. Next action: emit verification. ${'Y'.repeat(31_000)}`;
    const sourceC = `Later refreshed history after two distinct reads. Constraint: preserve each settled effect exactly once. Decision: finish after this observation. Exact identifier: compaction-source-c.txt. Next action: emit verification. ${'Z'.repeat(31_000)}`;
    const incompleteSummary = 'INCOMPLETE SUMMARY MUST NEVER CONTINUE';
    const correctedSummary = `Unresolved task: finish card-a verification. Constraint: preserve exact admission. Decision: continue without replay because the write effect already succeeded. Exact identifier: record:///status.md?card=card-a. Next action: emit the workflow result. ${'P'.repeat(30_000)}`;
    const finalSummary = 'Refreshed history: the status write and A/B reads succeeded. Constraint: do not duplicate settled tool effects. Decision: emit verification next. Exact identifier: card-a. Next action: call emit_result.';
    const executorEffects: string[] = [];
    const analystTools: Array<{ name: string; args: object }> = [
      { name: 'write', args: { path: 'record:///brief.md?card=project', content: 'Disposable Analyst bootstrap edit.' } },
      { name: 'create_card', args: { type: 'code', parent: 'project', title: 'Promoted child', bootstrap_content: 'Produce and review child evidence.', priority: 0, urgency: 'normal', depends_on: [] } },
      { name: 'create_card', args: { type: 'goal', parent: 'card-a', title: 'Forbidden nested goal', bootstrap_content: 'Must be rejected by parent narrowing.', priority: 0, urgency: 'normal', depends_on: [] } },
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
      const isSummary = names.length === 0 && body.max_tokens === 2_000;
      if (isSummary) {
        summaryCalls += 1;
        summaryRequests.push(body);
        summaryExecutorCounts.push(executorCalls);
        if (summaryCalls === 1) {
          originalExecutorConversation = readConversation(root, 'agent:executor:card-a');
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { content: incompleteSummary }, finish_reason: 'length' }] }));
        } else if (summaryCalls === 2) {
          finalMessage(response, correctedSummary);
        } else if (summaryCalls === 3) {
          finalMessage(response, finalSummary);
        } else throw new Error(`Unexpected summary call ${summaryCalls}.`);
        return;
      }
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
          toolCall(response, 100, 'write', { path: 'record:///status.md?card=project', content: 'Pre-restart open planning status.' });
          return;
        }
        oldPlannerBlocked = true;
        response.once('close', () => { oldPlannerRequestClosed = true; });
        return;
      }

      if (isPlanner && body.model === 'executor-model') {
        recoveryPlannerCalls += 1;
        if (recoveryPlannerCalls === 1) {
          toolCall(response, 200, 'write', { path: 'record:///status.md?card=project', content: 'Recovered plan with closed child evidence.' });
        } else if (recoveryPlannerCalls === 2) {
          toolCall(response, 201, 'activate_card', { card_id: 'card-a' });
        } else if (recoveryPlannerCalls === 3) {
          activationToolResult = last?.content ?? '';
          if (activationToolResult.includes('"outcome":"failed"')) throw new Error(`Child failed before parent review: ${activationToolResult.slice(0, 1000)}`);
          toolCall(response, 202, 'emit_result', { outcome: 'admit_review', summary: 'Parent submits after promoted child completion.' });
        } else throw new Error(`Unexpected recovery Planner call ${recoveryPlannerCalls}.`);
        return;
      }

      if (isExecutor) {
        executorCalls += 1;
        if (executorCalls === 1) {
          executorEffects.push('status-write');
          toolCall(response, 300, 'write', { path: 'record:///status.md?card=card-a', content: 'Ordered child status export.' });
        } else if (executorCalls === 2) {
          executorEffects.push('first-large-read');
          toolCall(response, 301, 'read', { path: 'project:///compaction-source-a.txt' });
        } else if (executorCalls === 3) {
          executorEffects.push('second-large-read');
          toolCall(response, 302, 'read', { path: 'project:///compaction-source-b.txt' });
        } else if (executorCalls === 4) {
          publishedExecutorRequest = body;
          publishedExecutorSegment = readCurrentConversationSegment(root, 'agent:executor:card-a');
          summaryCallsBeforeC = summaryCalls;
          executorEffects.push('third-large-read');
          toolCall(response, 303, 'read', { path: 'project:///compaction-source-c.txt' });
        } else if (executorCalls === 5) {
          continuedExecutorRequest = body;
          continuedExecutorSegment = readCurrentConversationSegment(root, 'agent:executor:card-a');
          toolCall(response, 304, 'emit_result', { outcome: 'verify', summary: 'Promoted executor summary.' });
        } else throw new Error(`Unexpected Executor call ${executorCalls}.`);
        return;
      }

      reviewerCalls += 1;
      if (reviewerCalls === 1) toolCall(response, 400, 'write', { path: 'record:///review.md?card=card-a', content: 'Child review export.' });
      else if (reviewerCalls === 2) toolCall(response, 401, 'emit_result', { outcome: 'approved', summary: 'Verifier summary must not be promoted.' });
      else if (reviewerCalls === 3) {
        const cards = app!.server.runtimeApplication.cardStore;
        const status=cards.readRecordCurrent('project','status.md');rootStatusClosedBeforeReview = status.kind==='found'&&status.value.projection?.accepted?.content === 'Recovered plan with closed child evidence.';
        toolCall(response, 402, 'write', { path: 'record:///review.md?card=project', content: 'Root review after closed plan status.' });
      } else if (reviewerCalls === 4) toolCall(response, 403, 'emit_result', { outcome: 'approved', summary: 'Root review approved.' });
      else throw new Error(`Unexpected Reviewer call ${reviewerCalls}: ${last?.content.slice(0, 500)}`);
    });
    const providerPort = await listen(provider);

    try {
      const freshInitOutput = runCli(root, 'init');
      expect(freshInitOutput).toContain(`Project layout initialized at ${root}`);
      expect(freshInitOutput).toContain('Configuration materialized from template classic');
      expect(readCommittedCardCurrent(root, 'project')).toMatchObject({ kind: 'found', value: { card: { id: 'project' } } });
      writeFileSync(join(root, 'compaction-source-a.txt'), sourceA);
      writeFileSync(join(root, 'compaction-source-b.txt'), sourceB);
      writeFileSync(join(root, 'compaction-source-c.txt'), sourceC);
      const config = testConfig(providerPort, appPort);
      config.providers.fake!.modelCapabilities = { 'analyst-model': { contextWindowTokens: 100_000 } };
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(config));
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
      expect(app.server.runtimeApplication.cardStore.readRecordCurrent('project','brief.md')).toMatchObject({kind:'found',value:{projection:{accepted:{content:'Disposable Analyst bootstrap edit.'}}}});
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
      expect(executorCalls).toBe(5);
      expect(reviewerCalls).toBe(4);
      expect(rootStatusClosedBeforeReview).toBe(true);
      const activation = JSON.parse(activationToolResult);
      expect(activation).toMatchObject({ success: true, data: { outcome: 'done', summary: 'Promoted executor summary.' } });
      expect(activation.data.result).toMatchObject({ agent_name: 'executor', node_id: 'execute', summary: 'Promoted executor summary.' });
      expect(activation.data.result.records.map((record: any) => record.name)).toEqual(['status.md', 'review.md']);
      expect(app.server.runtimeApplication.cardStore.read('card-a')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Promoted executor summary.' } } });
      expect(app.server.runtimeApplication.cardStore.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'Root review approved.' } } });
      expect(summaryCalls).toBe(3);
      expect(executorEffects).toEqual(['status-write', 'first-large-read', 'second-large-read', 'third-large-read']);
      expect(summaryRequests[0]!.messages.slice(1)).toEqual(summaryRequests[1]!.messages.slice(1));
      expect(summaryRequests[0]!.messages.some((message) => message.content.includes('Unresolved task: finish card-a verification'))).toBe(true);
      expect(summaryRequests[0]!.messages.some((message) => message.content.includes('Constraint: preserve exact admission'))).toBe(true);
      expect(summaryRequests[0]!.messages.some((message) => message.content.includes('record:///status.md?card=card-a'))).toBe(true);
      expect(summaryRequests[0]!.messages.some((message) => message.content.includes('"cardId":"card-a"'))).toBe(true);
      expect(summaryRequests[1]!.messages[0]!.content).toContain('6000 UTF-8 bytes');
      // Correction regenerates write/A; the furthest endpoint folds only B before C executes.
      expect(summaryExecutorCounts).toEqual([3, 3, 3]);
      expect(summaryCallsBeforeC).toBe(3);
      const originalRows = originalExecutorConversation!.sourceRows;
      expect(originalExecutorConversation!.effectiveCompactedHistory).toBeNull();
      expect(originalRows.some((row) => row.tool_call_id === 'call-303')).toBe(false);
      const canonicalPair = (rows: typeof originalRows, id: string) => {
        const calls = rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === id);
        const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === id);
        expect(calls).toHaveLength(1);
        expect(results).toHaveLength(1);
        expect(rows.indexOf(results[0]!)).toBe(rows.indexOf(calls[0]!) + 1);
        const callBody = JSON.parse(calls[0]!.content) as { tool_calls: NonNullable<ChatMessage['tool_calls']> };
        expect(callBody.tool_calls).toHaveLength(1);
        const call = callBody.tool_calls[0]!;
        expect(call.id).toBe(id);
        expect(call.type).toBe('function');
        return { call: calls[0]!, result: results[0]!, arguments: call.function.arguments, name: call.function.name };
      };
      const writePair = canonicalPair(originalRows, 'call-300');
      const aPair = canonicalPair(originalRows, 'call-301');
      const bPair = canonicalPair(originalRows, 'call-302');
      expect(writePair.name).toBe('write');
      expect(JSON.parse(writePair.arguments)).toEqual({ path: 'record:///status.md?card=card-a', content: 'Ordered child status export.' });
      expect(JSON.parse(writePair.result.content).success).toBe(true);
      for (const [pair, path, text] of [[aPair, 'a', sourceA], [bPair, 'b', sourceB]] as const) {
        expect(pair.name).toBe('read');
        expect(JSON.parse(pair.arguments)).toEqual({ path: `project:///compaction-source-${path}.txt` });
        expect(JSON.parse(pair.result.content)).toMatchObject({ success: true, data: { content: { content: text } } });
      }
      // Labels separate new source from orientation and accumulated history; compare complete bodies.
      const newSource = (request: ChatRequest) => request.messages.flatMap((message) => {
        const match = /^\[order \d+\/\d+\] \[kind=new_source source=(\S+) source_kind=(\S+) [^\n]*\]\n/.exec(message.content);
        return match ? [{ source: match[1]!, kind: match[2]!, body: message.content.slice(match[0].length) }] : [];
      });
      const sourceComponents = (pair: ReturnType<typeof canonicalPair>) => {
        const inputId = pair.call.id.slice(0, pair.call.id.indexOf(':tool-call:'));
        return [
          { source: `${inputId}:${pair.call.tool_call_id}:arguments`, kind: `tool_arguments:${pair.name}`, body: pair.arguments },
          { source: `${inputId}:${pair.call.tool_call_id}:result`, kind: `tool_result:${pair.name}`, body: pair.result.content },
        ];
      };
      expect(newSource(summaryRequests[0]!)).toEqual([...sourceComponents(writePair), ...sourceComponents(aPair)]);
      expect(newSource(summaryRequests[2]!)).toEqual(sourceComponents(bPair));
      const inheritedHistory = (request: ChatRequest) => request.messages
        .filter((message) => /^\[order \d+\/\d+\] \[kind=inherited_history\]\n/.test(message.content))
        .map((message) => message.content.slice(message.content.indexOf('\n') + 1));
      expect(inheritedHistory(summaryRequests[0]!)).toEqual([]);
      expect(inheritedHistory(summaryRequests[1]!)).toEqual([]);
      expect(inheritedHistory(summaryRequests[2]!)).toEqual([correctedSummary]);
      expect(summaryRequests.every((request) => request.messages.every((message) => !message.content.includes(incompleteSummary)))).toBe(true);
      const published = publishedExecutorSegment!;
      expect(published.entry.version).toBe(2);
      expect(published.genesis).toMatchObject({
        kind: 'compacted_segment_genesis', source: { covered_through_message_id: bPair.result.id }, compaction: { summaryText: finalSummary },
      });
      // Primary admission has already appended its activity row by this HTTP callback.
      expect(published.rows.some((row) => row.kind === 'tool_call' || row.kind === 'tool_result')).toBe(false);
      expect(publishedExecutorRequest!.messages.filter((message) => message.content === `Historical summary:\n${finalSummary}`)).toHaveLength(1);
      expect(continuedExecutorSegment!.entry).toEqual(published.entry);
      expect(continuedExecutorSegment!.genesis).toEqual(published.genesis);
      const cPair = canonicalPair(continuedExecutorSegment!.rows, 'call-303');
      expect(cPair.name).toBe('read');
      expect(JSON.parse(cPair.arguments)).toEqual({ path: 'project:///compaction-source-c.txt' });
      expect(JSON.parse(cPair.result.content)).toMatchObject({ success: true, data: { content: { content: sourceC } } });
      const cMessages = continuedExecutorRequest!.messages;
      const cCalls = cMessages.filter((message) => message.tool_calls?.some((call) => call.id === 'call-303'));
      const cResults = cMessages.filter((message) => message.role === 'tool' && message.tool_call_id === 'call-303');
      expect(cCalls).toHaveLength(1);
      expect(cResults).toHaveLength(1);
      expect(cCalls[0]!.tool_calls).toEqual([{ id: 'call-303', type: 'function', function: { name: 'read', arguments: cPair.arguments } }]);
      expect(cMessages.indexOf(cResults[0]!)).toBe(cMessages.indexOf(cCalls[0]!) + 1);
      expect(cResults[0]!.content).toBe(cPair.result.content);
      const executorConversation = readConversation(root, 'agent:executor:card-a');
      expect(executorConversation.effectiveCompactedHistory?.summaryText).toBe(finalSummary);
      const finalSegment = readCurrentConversationSegment(root, 'agent:executor:card-a')!;
      expect(finalSegment.entry).toEqual(published.entry);
      expect(finalSegment.genesis).toEqual(published.genesis);
      const finalCPair = canonicalPair(finalSegment.rows, 'call-303');
      expect(finalCPair).toEqual(cPair);
      expect(finalCPair.result.content).toBe(cResults[0]!.content);
      expect(JSON.parse(finalCPair.result.content)).toMatchObject({ success: true, data: { content: { content: sourceC } } });
      const internalExchanges = readFileSync(providerExchangeFile(root, 'agent:executor:card-a'), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ type: string; data: { session_id?: string } }> }).rows).filter((row) => row.type === 'provider_exchange' && row.data.session_id?.startsWith('internal:compaction-summary:'));
      expect(internalExchanges).toHaveLength(3);
      const beforeRestart = await api(app, '/api/agents/agent%3Aexecutor%3Acard-a/llm-exchange');
      expect(beforeRestart.status).toBe(200);
      expect(beforeRestart.body.session_id).toBe('agent:executor:card-a');
      expect(beforeRestart.body.exchange.status).toBe('ok');
      expect(beforeRestart.body.exchange.model).toBe('executor-model');
      await stop(app);
      app = await start(root);
      const afterRestart = await api(app, '/api/agents/agent%3Aexecutor%3Acard-a/llm-exchange');
      expect(afterRestart).toEqual(beforeRestart);

      expect(offeredTools.get('analyst')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.analyst.tools);
      expect(offeredTools.get('planner')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.planner.tools.concat('emit_result'));
      expect(offeredTools.get('executor')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.executor.tools.concat('emit_result'));
      expect(offeredTools.get('reviewer')).toEqual(DEFAULT_SAIVAGE_CONFIG.agents.reviewer.tools.concat('emit_result'));
      expect(offeredTools.get('reviewer')).not.toContain('mcp_tool_call');

      await stop(app);
      app = null;
      expect(runCli(root, 'reset')).toContain('Project reset with a new root project card');
      const postResetInitOutput = runCli(root, 'init');
      expect(postResetInitOutput).toContain(`Project layout already exists at ${root}`);
      expect(postResetInitOutput).toContain('Existing configuration preserved');
      const resetConfig = readFileSync(join(root, '.saivage', 'saivage.yaml'), 'utf8');
      expect(resetConfig).toContain('model_route: executor');
      expect(readCommittedCardCurrent(root, 'project')).toMatchObject({ kind: 'found', value: { card: { lifecycle: { status: 'backlog' } } } });
      expect(new CardService(root).readRecordCurrent('project', 'brief.md')).toMatchObject({ kind: 'found', value: { projection: { accepted: { writer_agent: 'runtime:bootstrap' } } } });
    } finally {
      if (app) await stop(app);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 90_000);
});
