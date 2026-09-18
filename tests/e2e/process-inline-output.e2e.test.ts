import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'process-inline-production-e2e-token';
const roots: string[] = [];
const apps = new Set<App>();

afterEach(async () => {
  for (const app of [...apps]) await app.stop();
  apps.clear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function toolResult(request: ChatCompletionRequest): { success: true; data: Record<string, unknown> } {
  const last = request.messages.at(-1);
  if (last?.role !== 'tool') throw new Error('Expected the provider continuation to end in a tool result.');
  const parsed = JSON.parse(last.content) as { success?: boolean; data?: unknown };
  if (parsed.success !== true || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))
    throw new Error(`Expected a successful object tool result, received ${last.content.slice(0, 500)}.`);
  return parsed as { success: true; data: Record<string, unknown> };
}

async function operatorGet(app: App, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${appOrigin(app)}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, connection: 'close' } });
  return { status: response.status, body: await response.json() };
}

describe('process inline output production composition', () => {
  it('projects real process heads to primary requests while retaining durable URLs and readable retired logs', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-inline-e2e-'));
    roots.push(projectRoot);
    const providerRequests: ChatCompletionRequest[] = [];
    const observedPrimaryResults: Record<string, unknown>[] = [];
    let fixtureFailure: Error | null = null;
    let analystCalls = 0;
    let executorCalls = 0;
    let waitProcessId = '';
    let waitStdoutUrl = '';
    let killProcessId = '';

    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected provider URL '${request.url}'.`);
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        providerRequests.push(body);
        const tools = offeredToolNames(body);
        if (tools.includes('start_project')) {
          analystCalls += 1;
          if (analystCalls === 1) sendToolCall(response, 'analyst-start', 'start_project', {});
          else if (analystCalls === 2) sendFinalMessage(response, 'Project started.');
          else throw new Error(`Unexpected Analyst request ${analystCalls}.`);
          return;
        }
        if (!tools.includes('run_command') || !tools.includes('wait_process') || !tools.includes('kill_process') || !tools.includes('read') || !tools.includes('emit_result'))
          throw new Error(`Unexpected executor tool set: ${tools.join(',')}.`);

        executorCalls += 1;
        if (executorCalls === 1) {
          const script = 'process.stdout.write("short-out");process.stderr.write(Buffer.from([0xf0,0x9f]));';
          sendToolCall(response, 'foreground-mixed', 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, timeout_ms: 2_000 });
        } else if (executorCalls === 2) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ status: 'exited', stdout: 'short-out', stderr: '', stdout_complete: true, stderr_complete: false });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          const script = 'process.stdout.write("wait-start");setTimeout(()=>{process.stdout.write("-wait-end")},150);';
          sendToolCall(response, 'background-wait', 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, wait: false });
        } else if (executorCalls === 3) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result.status).toBe('running');
          expect(result).toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          waitProcessId = String(result.process_id);
          waitStdoutUrl = String(result.stdout_url);
          sendToolCall(response, 'background-observe', 'wait_process', { process_id: waitProcessId, timeout_ms: 0 });
        } else if (executorCalls === 4) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result.status).toBe('running');
          expect(result).toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          sendToolCall(response, 'background-terminal-wait', 'wait_process', { process_id: waitProcessId, timeout_ms: 2_000 });
        } else if (executorCalls === 5) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ process_id: waitProcessId, status: 'exited', stdout: 'wait-start-wait-end', stdout_complete: true, stderr_complete: true });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).not.toHaveProperty('stderr_url');
          sendToolCall(response, 'read-retired-log', 'read', { path: waitStdoutUrl });
        } else if (executorCalls === 6) {
          const result = toolResult(body).data;
          expect(JSON.stringify(result)).toContain('wait-start-wait-end');
          const script = 'process.stdout.write("kill-start");setInterval(()=>{},1000);';
          sendToolCall(response, 'background-kill', 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, wait: false });
        } else if (executorCalls === 7) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result.status).toBe('running');
          expect(result).toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          killProcessId = String(result.process_id);
          sendToolCall(response, 'kill-terminal', 'kill_process', { process_id: killProcessId });
        } else if (executorCalls === 8) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ process_id: killProcessId, status: 'killed', stdout_complete: true, stderr_complete: true });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).not.toHaveProperty('stderr_url');
          sendToolCall(response, 'root-terminal', 'emit_result', { outcome: 'done', summary: 'Process lifecycle verified.' });
        } else throw new Error(`Unexpected executor request ${executorCalls}.`);
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
      const config = productionTestConfig(providerPort, (value) => {
        value.card_types.project = {
          permitted_child_types: [],
          records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
          workflow: {
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: {}, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: [] } } } } },
          },
        };
      });
      writeProductionConfig(projectRoot, config);
      app = await startProductionApp(projectRoot, TOKEN);
      apps.add(app);

      const started = await postStartProject(appOrigin(app), TOKEN);
      expect(started.status).toBe(200);
      const cards = app.server.runtimeApplication.cardStore;
      try { await waitFor(() => cards.read('project')?.lifecycle.status === 'done', 'process-backed root completion'); }
      catch (error) {
        throw new Error(`${(error as Error).message} fixture=${(fixtureFailure as Error | null)?.message ?? 'none'} calls=${JSON.stringify({ analystCalls, executorCalls })} conversation=${JSON.stringify(readConversation(projectRoot, 'agent:executor:project').physicalRows)}`);
      }
      if (fixtureFailure) throw fixtureFailure;

      const durableRows = readConversation(projectRoot, 'agent:executor:project').physicalRows;
      const processResults = durableRows.filter((row) => row.kind === 'tool_result' && ['run_command', 'wait_process', 'kill_process'].includes(row.tool ?? '')).map((row) => JSON.parse(row.content).data as Record<string, unknown>);
      expect(processResults).toHaveLength(6);
      expect(processResults.every((result) => typeof result.stdout_url === 'string' && typeof result.stderr_url === 'string')).toBe(true);
      expect(processResults[0]).toMatchObject({ stdout: 'short-out', stdout_complete: true, stderr_complete: false });
      expect(processResults.find((result) => result.process_id === waitProcessId && result.status === 'exited')).toMatchObject({ stdout_url: waitStdoutUrl, stdout: 'wait-start-wait-end' });

      const sessionId = encodeURIComponent('agent:executor:project');
      const conversationResponse = await operatorGet(app, `/api/agents/${sessionId}/conversation`);
      expect(conversationResponse.status).toBe(200);
      const apiProcessResults = conversationResponse.body.entries.filter((entry: any) => entry.kind === 'tool_result' && ['run_command', 'wait_process', 'kill_process'].includes(entry.tool)).map((entry: any) => JSON.parse(entry.content).data);
      expect(apiProcessResults).toEqual(processResults);
      const processesResponse = await operatorGet(app, '/api/processes');
      expect(processesResponse).toEqual({ status: 200, body: { processes: [] } });
      expect(observedPrimaryResults).toHaveLength(6);
      expect(providerRequests.length).toBe(analystCalls + executorCalls);
      expect({ analystCalls, executorCalls }).toEqual({ analystCalls: 2, executorCalls: 8 });
    } finally {
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider);
    }
  }, 60_000);
});
