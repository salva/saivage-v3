import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { App } from '../../src/boot/app.js';
import { quoteBashWord } from '../helpers/bash-word.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { parseActivationOpenPayload } from '../../src/schemas/index.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
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
  jest.restoreAllMocks(); syncBuiltinESMExports();
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
    const parent = mkdtempSync(join(tmpdir(), 'saivage-process-inline-e2e-'));
    roots.push(parent);
    const executable = join(parent, 'Node 24 \' " $HOME `node`');
    symlinkSync(process.execPath, executable);
    const projectRoot = join(parent, 'project');
    const sibling = join(parent, 'sibling');
    const releasePath = join(parent, 'wait-release');
    mkdirSync(projectRoot);
    mkdirSync(sibling);
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
          sendToolCall(response, 'foreground-mixed', 'run_command', { command: `${quoteBashWord(executable)} -e ${quoteBashWord(script)}`, timeout_ms: 2_000 });
        } else if (executorCalls === 2) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ status: 'exited', stdout: 'short-out', stderr: '', stdout_complete: true, stderr_complete: false });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          const script = `const fs=require('node:fs');process.stdout.write("wait-start");const timer=setInterval(()=>{try{fs.accessSync(${JSON.stringify(releasePath)});}catch(error){if(error.code==='ENOENT')return;throw error;}clearInterval(timer);process.stdout.write("-wait-end");},10);`;
          sendToolCall(response, 'background-wait', 'run_command', { command: `timeout --kill-after=1s 10s ${quoteBashWord(executable)} -e ${quoteBashWord(script)}`, wait: false });
        } else if (executorCalls === 3) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result.status).toBe('running');
          expect(result).toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          waitProcessId = String(result.process_id);
          waitStdoutUrl = String(result.stdout_url);
          // Observe through another provider turn beyond the former 150 ms lifetime.
          await new Promise((resolve) => setTimeout(resolve, 750));
          sendToolCall(response, 'background-observe', 'wait_process', { process_id: waitProcessId, timeout_ms: 0 });
        } else if (executorCalls === 4) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result.status).toBe('running');
          expect(result).toHaveProperty('stdout_url');
          expect(result).toHaveProperty('stderr_url');
          writeFileSync(releasePath, 'release');
          sendToolCall(response, 'background-terminal-wait', 'wait_process', { process_id: waitProcessId, timeout_ms: 2_000 });
        } else if (executorCalls === 5) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ process_id: waitProcessId, status: 'exited', exit_code: 0, stdout: 'wait-start-wait-end', stdout_complete: true, stderr_complete: true });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).not.toHaveProperty('stderr_url');
          sendToolCall(response, 'read-retired-log', 'read', { path: waitStdoutUrl });
        } else if (executorCalls === 6) {
          const result = toolResult(body).data;
          expect(JSON.stringify(result)).toContain('wait-start-wait-end');
          const script = 'process.stdout.write("kill-start");setInterval(()=>{},1000);';
          sendToolCall(response, 'background-kill', 'run_command', { command: `${quoteBashWord(executable)} -e ${quoteBashWord(script)}`, wait: false });
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
          sendToolCall(response, 'outside-project-pwd', 'run_command', { command: 'timeout --kill-after=1s 5s pwd', cwd: sibling, timeout_ms: 10_000 });
        } else if (executorCalls === 9) {
          const result = toolResult(body).data;
          observedPrimaryResults.push(result);
          expect(result).toMatchObject({ status: 'exited', exit_code: 0, stdout: `${sibling}\n`, stderr: '', stdout_complete: true, stderr_complete: true });
          expect(result).not.toHaveProperty('stdout_url');
          expect(result).not.toHaveProperty('stderr_url');
          sendToolCall(response, 'root-terminal', 'emit_result', { outcome: 'done', summary: 'Process lifecycle and outside-project cwd verified.' });
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
      const config = productionTestConfig(providerPort, (value) => {
        value.card_types.project = {
          permitted_child_types: [],
          records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
          workflow: { format_version: 1,
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute', prompt: { reference: 'correct-execution-result', compactable: true } }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { execution: { kind: 'agent', agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true } }, records: {}, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: [] } } } } },
          },
        };
      });
      writeProductionConfig(projectRoot, config);
      const promptRoot = resolveSystemTemplate('classic-typed').promptRoot;
      for (const [purpose,reference,sentinel] of [['agents','executor','ROLE'],['process','execute','NODE']]) {
        const directory=join(projectRoot,'.saivage','config','prompts',purpose!,'_shared');
        mkdirSync(directory,{recursive:true});
        writeFileSync(join(directory,`${reference}.md`),`${readFileSync(join(promptRoot,purpose!,'_shared',`${reference}.md`),'utf8')}\n${sentinel}-PUBLIC-SENTINEL token=tok_${sentinel!.toLowerCase()}_private\n`);
      }
      initializeProject(projectRoot);
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
      const markers = durableRows.filter(row => row.kind === 'activity' && parseActivationOpenPayload(row.content,row.session_id,row.timestamp));
      expect(markers).toHaveLength(1);
      const marker = markers[0]!;
      const firstRequest = providerRequests.find(request => offeredToolNames(request).includes('emit_result'))!;
      const nodeText = firstRequest.messages.find(message => message.content.startsWith("Current workflow node 'execute':"))!.content;
       expect(parseActivationOpenPayload(marker.content,marker.session_id,marker.timestamp)?.instructions).toMatchObject({
        kind:'prepared',role_text:firstRequest.messages[0]!.content,node:{node_id:'execute',text:nodeText},
      });
      const entryPrompt = durableRows.find(row => row.instruction_origin === 'workflow_prompt')!;
      expect(entryPrompt).toMatchObject({role:'user',kind:'text'});
      expect(durableRows.indexOf(marker)).toBeLessThan(durableRows.indexOf(entryPrompt));
      expect(providerRequests.every(request => !JSON.stringify(request).includes('instruction_origin'))).toBe(true);
      const processResults = durableRows.filter((row) => row.kind === 'tool_result' && ['run_command', 'wait_process', 'kill_process'].includes(row.tool ?? '')).map((row) => JSON.parse(row.content).data as Record<string, unknown>);
      expect(processResults).toHaveLength(7);
      expect(processResults.every((result) => typeof result.stdout_url === 'string' && typeof result.stderr_url === 'string')).toBe(true);
      expect(processResults[0]).toMatchObject({ stdout: 'short-out', stdout_complete: true, stderr_complete: false });
      const outsideResult = processResults.at(-1)!;
      expect(outsideResult).toMatchObject({ status: 'exited', exit_code: 0, stdout: `${sibling}\n`, stdout_url: `work:///cards/project/processes/${outsideResult.process_id}/stdout.log` });
      expect(readFileSync(join(projectRoot, '.saivage', 'work', 'cards', 'project', 'processes', String(outsideResult.process_id), 'stdout.log'), 'utf8')).toBe(`${sibling}\n`);
      expect(processResults.find((result) => result.process_id === waitProcessId && result.status === 'exited')).toMatchObject({ stdout_url: waitStdoutUrl, stdout: 'wait-start-wait-end' });

      const sessionId = encodeURIComponent('agent:executor:project');
      const projectionReads:string[]=[];
      const observeRead = (path: fs.PathLike | number): void => {
        if(typeof path==='number') return;
        const name=String(path);
        projectionReads.push(name);
        for(const forbidden of ['/diagnostics/','auth-profiles.json','saivage.yaml','/config/prompts/','provider-exchange.jsonl','/private-replay/','/native-fields/'])
          if(name.includes(forbidden)) throw new Error(`Instruction projection attempted forbidden private/current-config read: ${forbidden}`);
      };
      const originalRead=fs.readFileSync;
      const originalOpen=fs.openSync;
      const readSpy=jest.spyOn(fs,'readFileSync').mockImplementation(((path:fs.PathOrFileDescriptor,...args:unknown[])=>{
        observeRead(path); return Reflect.apply(originalRead,fs,[path,...args]);
      }) as typeof fs.readFileSync);
      const openSpy=jest.spyOn(fs,'openSync').mockImplementation((path,flags,...args)=>{
        observeRead(path); return originalOpen(path,flags,...args);
      });
      syncBuiltinESMExports();
      const conversationResponse = await operatorGet(app, `/api/agents/${sessionId}/conversation`);
      expect(conversationResponse.status).toBe(200);
      expect(JSON.stringify(conversationResponse.body)).not.toContain('test-only-provider-key');
      expect(JSON.stringify(conversationResponse.body)).not.toContain(`http://127.0.0.1:${providerPort}`);
      expect(conversationResponse.body.entries.find((row: any) => row.id === entryPrompt.id).instruction_origin).toBe('workflow_prompt');
       expect(JSON.parse(conversationResponse.body.entries.find((row: any) => row.id === marker.id).content).instructions).toMatchObject({
        kind:'prepared',role_text:redactTextForOutbound(firstRequest.messages[0]!.content),node:{node_id:'execute',text:redactTextForOutbound(nodeText)},
      });
      for(const sentinel of ['tok_role_private','tok_node_private']) {
        expect(JSON.stringify(conversationResponse.body)).not.toContain(sentinel);
        expect(marker.content).toContain(sentinel);
      }
      expect(JSON.stringify(conversationResponse.body)).toContain('ROLE-PUBLIC-SENTINEL');
      expect(JSON.stringify(conversationResponse.body)).toContain('NODE-PUBLIC-SENTINEL');
      const incrementalQuery = new URLSearchParams({segment_id:conversationResponse.body.segment_id,segment_version:String(conversationResponse.body.segment_version),since:marker.id});
      const incremental = await operatorGet(app, `/api/agents/${sessionId}/conversation?${incrementalQuery}`);
      expect(incremental.status).toBe(200);
      expect(incremental.body.entries.some((row: any) => row.id === marker.id)).toBe(false);
      expect(incremental.body.entries.filter((row: any) => row.id === entryPrompt.id)).toEqual([
        conversationResponse.body.entries.find((row: any) => row.id === entryPrompt.id),
      ]);
      const historical = await operatorGet(app, `/api/agents/${sessionId}/conversation/versions/1`);
      expect(historical.status).toBe(200);
      expect(historical.body.entries).toEqual(conversationResponse.body.entries);
      const configuredBefore = await operatorGet(app, `/api/agents/${sessionId}/current-instructions`);
      expect(configuredBefore.status).toBe(200);
      expect(projectionReads.some(path=>path.endsWith('/index.json'))).toBe(true);
      expect(projectionReads.some(path=>path.endsWith('.jsonl'))).toBe(true);
      readSpy.mockRestore(); openSpy.mockRestore(); syncBuiltinESMExports();
      const apiProcessResults = conversationResponse.body.entries.filter((entry: any) => entry.kind === 'tool_result' && ['run_command', 'wait_process', 'kill_process'].includes(entry.tool)).map((entry: any) => JSON.parse(entry.content).data);
      expect(apiProcessResults).toEqual(processResults);
      const processesResponse = await operatorGet(app, '/api/processes');
      expect(processesResponse).toEqual({ status: 200, body: { processes: [] } });
      expect(observedPrimaryResults).toHaveLength(7);
      expect(providerRequests.length).toBe(analystCalls + executorCalls);
      expect({ analystCalls, executorCalls }).toEqual({ analystCalls: 2, executorCalls: 9 });
      apps.delete(app); await app.stop();
      const overrideDirectory = join(projectRoot,'.saivage','config','prompts','agents','_shared');
      mkdirSync(overrideDirectory,{recursive:true});
      writeFileSync(join(overrideDirectory,'executor.md'),`${readFileSync(join(resolveSystemTemplate('classic-typed').promptRoot,'agents','_shared','executor.md'),'utf8')}\nCURRENT-CONFIG-ONLY-SENTINEL\n`);
      app = await startProductionApp(projectRoot,TOKEN); apps.add(app);
      const configuredAfter = await operatorGet(app, `/api/agents/${sessionId}/current-instructions`);
      expect(configuredAfter.status).toBe(200);
      expect(JSON.stringify(configuredAfter.body)).toContain('CURRENT-CONFIG-ONLY-SENTINEL');
      expect(configuredAfter.body).not.toEqual(configuredBefore.body);
      const retained = await operatorGet(app, `/api/agents/${sessionId}/conversation/versions/1`);
      expect(retained).toEqual(historical);
      expect(JSON.stringify(retained.body)).not.toContain('CURRENT-CONFIG-ONLY-SENTINEL');
      expect(providerRequests.length).toBe(analystCalls + executorCalls);
    } finally {
      jest.restoreAllMocks(); syncBuiltinESMExports();
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider);
    }
  }, 60_000);
});
