import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from '../../src/boot/app.js';
import { CardService } from '../../src/cards/card-service.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';
import { readRuntimeLockStatus } from '../../src/runtime/lock.js';
import { MODEL_RECOVERY_NOTICE_TEXT } from '../../src/schemas/index.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'supervisor-recovery-e2e-token';
const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX_LOADER = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
const roots: string[] = [];
const apps = new Set<App>();
const children = new Set<ChildProcess>();

function latestActivationInput(projectRoot: string, sessionId: `agent:${string}:${string}`): string {
  const marker = readConversation(projectRoot, sessionId).physicalRows.filter((row) => row.kind === 'activity' && row.content.includes('"event":"activation_open"')).at(-1);
  if (!marker) throw new Error(`No activation marker exists for '${sessionId}'.`);
  return (JSON.parse(marker.content) as { input_id: string }).input_id;
}

function versionEntries(cards: CardService, cardId: string) {
  const result = cards.listCardVersions(cardId);
  if (result.kind !== 'found') throw new Error(`Card '${cardId}' has no canonical version stream.`);
  return result.value;
}

async function awaitChildExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = awaitChildExit(child);
      child.kill('SIGKILL');
      await exited;
    }
    children.delete(child);
  }
  for (const app of [...apps]) await app.stop();
  apps.clear();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Supervisor kill/restart full-chain recovery', () => {
  it('recovers a durably running root and held child leaf-to-root without replaying interrupted inputs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-recovery-e2e-'));
    roots.push(projectRoot);
    let fixtureFailure: Error | null = null;
    let analystRequests = 0;
    let rootRequests = 0;
    let childRequests = 0;
    let heldChildResponseClosed = false;
    let preKillRootInput = '';
    let preKillChildInput = '';

    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected provider URL '${request.url}'.`);
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        const tools = offeredToolNames(body);
        const last = body.messages.at(-1);
        if (tools.includes('start_project')) {
          analystRequests += 1;
          if (analystRequests === 1 || analystRequests === 3) {
            sendToolCall(response, `analyst-start-${analystRequests}`, 'start_project', {});
          } else if (analystRequests === 2 || analystRequests === 4) {
            const settlement = JSON.parse(last?.content ?? 'null');
            if (last?.role !== 'tool' || settlement.success !== true) throw new Error('Analyst continuation did not contain a successful start_project settlement.');
            sendFinalMessage(response, 'Project started.');
          } else throw new Error(`Unexpected Analyst request ${analystRequests}.`);
          return;
        }
        if (tools.includes('activate_card')) {
          rootRequests += 1;
          const inputId = latestActivationInput(projectRoot, 'agent:planner:project');
          if (rootRequests === 1) {
            preKillRootInput = inputId;
            sendToolCall(response, 'root-activate-child', 'activate_card', { card_id: 'card-a' });
          } else if (rootRequests === 2) {
            if (inputId === preKillRootInput) throw new Error('Interrupted root provider input was replayed.');
            sendToolCall(response, 'root-recovery-terminal', 'emit_result', { outcome: 'blocked', summary: 'Recovered root stopped on its interrupted child.' });
          } else throw new Error(`Unexpected root request ${rootRequests}.`);
          return;
        }
        if (!tools.includes('emit_result')) throw new Error(`Unexpected provider tool set: ${tools.join(',')}.`);
        childRequests += 1;
        if (childRequests !== 1) throw new Error('Interrupted child provider input was replayed.');
        preKillChildInput = latestActivationInput(projectRoot, 'agent:executor:card-a');
        const markHeldRequestClosed = () => { heldChildResponseClosed = true; };
        request.once('aborted', markHeldRequestClosed);
        request.socket.once('end', markHeldRequestClosed);
        request.socket.once('close', markHeldRequestClosed);
        response.once('close', markHeldRequestClosed);
      } catch (error) {
        fixtureFailure = error as Error;
        response.statusCode = 500; response.end();
      }
    });
    const providerPort = await listen(provider);
    let firstChild: ChildProcess | null = null;
    let secondApp: App | null = null;
    try {
      initializeProject(projectRoot);
      const config = productionTestConfig(providerPort, (value) => {
        value.card_types.project = {
          permitted_child_types: ['code'],
          records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
          workflow: {
            notification_recipient: 'planner',
            entries: { BACKLOG: { node: 'plan' }, CHANGED: { node: 'plan' }, BLOCKED: { node: 'plan' }, STOPPED: { node: 'plan', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { plan: { agent: 'planner', prompt: { reference: 'plan', compactable: true }, correction_prompt: { reference: 'correct-plan-result', compactable: true }, records: {}, edges: { blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } } } } },
          },
        };
        value.card_types.code = {
          permitted_child_types: [],
          records: {
            'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
            'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
          },
          workflow: {
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: {}, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: [] } } } } },
          },
        };
      });
      writeProductionConfig(projectRoot, config);
      const setupCards = new CardService(projectRoot, compileProjectWorkflows(config, { projectRoot }));
      const child = setupCards.create({ type: 'code', parent: 'project', title: 'Held child', bootstrap_content: 'Wait in the provider request.', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
      expect(child.id).toBe('card-a');

      let childStdout = '';
      let childStderr = '';
      firstChild = spawn(process.execPath, ['--import', TSX_LOADER, CLI, 'start', '--project-root', projectRoot, '--host', '127.0.0.1', '--port', '0'], {
        cwd: projectRoot,
        env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', SAIVAGE_API_TOKEN: TOKEN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(firstChild);
      firstChild.stdout!.on('data', (chunk) => { childStdout += String(chunk); });
      firstChild.stderr!.on('data', (chunk) => { childStderr += String(chunk); });

      let firstOrigin = '';
      await waitFor(() => {
        const status = readRuntimeLockStatus(projectRoot);
        if (status.kind !== 'live' || status.record.control_endpoint === null) return false;
        firstOrigin = status.record.control_endpoint.origin;
        return true;
      }, 'the first CLI owner to publish its live control endpoint');
      const liveOwner = readRuntimeLockStatus(projectRoot);
      if (liveOwner.kind !== 'live') throw new Error('First CLI owner was not live after readiness publication.');
      expect(liveOwner.record.pid).toBe(firstChild.pid);
      const ready = await fetch(`${firstOrigin}/health/ready`);
      expect(ready.status).toBe(200);
      const firstStarted = await postStartProject(firstOrigin, TOKEN);
      expect(firstStarted.status).toBe(200);
      expect(firstStarted.body.toolInvocations).toEqual([expect.objectContaining({ tool: 'start_project', params: {}, result: expect.objectContaining({ success: true }) })]);

      const liveCards = new CardService(projectRoot, compileProjectWorkflows(config, { projectRoot }));
      await waitFor(() => liveCards.read('project')?.lifecycle.status === 'running' && liveCards.read('card-a')?.lifecycle.status === 'running' && preKillChildInput.length > 0, 'the durably running chain and held child provider request');
      if (fixtureFailure) throw fixtureFailure;
      const preKillVersions = { project: liveCards.read('project')!.version_seq, child: liveCards.read('card-a')!.version_seq };
      expect(preKillRootInput).not.toBe('');

      const exited = awaitChildExit(firstChild);
      expect(firstChild.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      children.delete(firstChild);
      await waitFor(() => heldChildResponseClosed, 'the killed child provider request to close');
      expect(readRuntimeLockStatus(projectRoot).kind).toBe('dead');
      unlinkSync(runtimeProcessLockFile(projectRoot));

      const recoveryCalls: string[] = [];
      const originalStop = CardService.prototype.stopRunning;
      jest.spyOn(CardService.prototype, 'stopRunning').mockImplementation(function (this: CardService, cardId: string) {
        recoveryCalls.push(cardId);
        return originalStop.call(this, cardId);
      });

      secondApp = await startProductionApp(projectRoot, TOKEN);
      apps.add(secondApp);
      const secondStarted = await postStartProject(appOrigin(secondApp), TOKEN);
      expect(secondStarted.status).toBe(200);
      expect(secondStarted.body.toolInvocations).toEqual([expect.objectContaining({ tool: 'start_project', params: {}, result: expect.objectContaining({ success: true }) })]);
      const recoveredCards = secondApp.server.runtimeApplication.cardStore;
      try { await waitFor(() => recoveredCards.read('project')?.lifecycle.status === 'blocked' && secondApp!.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped', 'the fresh recovered Run to complete'); }
      catch (error) {
        throw new Error(`${(error as Error).message} fixture=${(fixtureFailure as Error | null)?.message ?? 'none'} counts=${JSON.stringify({ analystRequests, rootRequests, childRequests, recoveryCalls })} runtime=${JSON.stringify(secondApp.server.runtimeApplication.runtimeApi.getStatus())} project=${JSON.stringify(recoveredCards.read('project')?.lifecycle)} rootRows=${JSON.stringify(readConversation(projectRoot, 'agent:planner:project').physicalRows)}`);
      }

      if (fixtureFailure) throw fixtureFailure;
      expect(recoveryCalls).toEqual(['card-a', 'project']);
      const childNewVersions = versionEntries(recoveredCards, 'card-a').filter((entry) => entry.version > preKillVersions.child);
      expect(childNewVersions).toEqual([expect.objectContaining({ change: expect.objectContaining({ kind: 'status', changed_fields: ['lifecycle'], change_reason: 'recovery stopped lifecycle' }) })]);
      const rootNewVersions = versionEntries(recoveredCards, 'project').filter((entry) => entry.version > preKillVersions.project);
      expect(rootNewVersions.map((entry) => entry.change && ({ kind: entry.change.kind, fields: entry.change.changed_fields, reason: entry.change.change_reason }))).toEqual([
        { kind: 'status', fields: ['lifecycle'], reason: 'recovery stopped lifecycle' },
        { kind: 'status', fields: ['lifecycle'], reason: 'STOPPED activation' },
        expect.objectContaining({ kind: 'terminal', reason: 'terminal lifecycle commit' }),
      ]);
      expect(recoveredCards.read('card-a')?.lifecycle.status).toBe('stopped');
      expect(recoveredCards.read('project')).toMatchObject({ lifecycle: { status: 'blocked', result: { summary: 'Recovered root stopped on its interrupted child.' } } });

      const rootRows = readConversation(projectRoot, 'agent:planner:project').physicalRows;
      const oldRootResults = rootRows.filter((row) => row.id === `${preKillRootInput}:tool-result:root-activate-child`);
      expect(oldRootResults).toHaveLength(1);
      expect(JSON.parse(oldRootResults[0]!.content)).toEqual({ success: false, error: 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.', data: { outcome_unknown: true } });
      expect(oldRootResults[0]).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'execution_failed' } });
      expect(rootRows.filter((row) => row.id === `${preKillRootInput}:model-recovered`)).toEqual([expect.objectContaining({ kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT })]);
      const childRows = readConversation(projectRoot, 'agent:executor:card-a').physicalRows;
      expect(childRows.filter((row) => row.id === `${preKillChildInput}:model-recovered`)).toEqual([expect.objectContaining({ kind: 'model_recovered', content: MODEL_RECOVERY_NOTICE_TEXT })]);
      expect(childRows.filter((row) => row.kind === 'tool_call' || row.kind === 'tool_result')).toHaveLength(0);
      expect(rootRows.filter((row) => row.id === `${preKillRootInput}:started`)).toHaveLength(1);
      expect(childRows.filter((row) => row.id === `${preKillChildInput}:started`)).toHaveLength(1);
      expect({ analystRequests, rootRequests, childRequests, heldChildResponseClosed }).toEqual({ analystRequests: 4, rootRequests: 2, childRequests: 1, heldChildResponseClosed: true });
      expect(childStdout).toContain('Saivage server listening');
      expect(childStderr).toBe('');
    } finally {
      if (firstChild && firstChild.exitCode === null && firstChild.signalCode === null) {
        const exited = awaitChildExit(firstChild);
        firstChild.kill('SIGKILL');
        await exited;
        children.delete(firstChild);
      }
      if (secondApp) { apps.delete(secondApp); await secondApp.stop(); }
      await closeServer(provider);
    }
  }, 60_000);
});
