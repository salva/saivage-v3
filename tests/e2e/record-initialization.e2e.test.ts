import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { cardAgentSessionId } from '../../src/schemas/index.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage, sendToolCall,
  startProductionApp, waitFor, writeProductionConfig, type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const TOKEN = 'isolated-record-initialization-token';
const INITIAL = '# Assessment\nNot yet assessed. ${LITERAL}\n';
const REPLACEMENT = '# Revised organization\nNot yet assessed.\n';
describe('configured node-entry record initialization through production composition', () => {
  it('rejects untouched custom scaffolds, retains a seed on restart and exports only authored assessments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'record-initialization-e2e-')); roots.push(root);
    let app: App | null = null; let phase = 0; let calls = 0; let failure: unknown;
    const held: { response?: ServerResponse } = {}; let analystCalls = 0;
    const requests: ChatCompletionRequest[] = [];
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        if (offeredToolNames(body).includes('start_project')) {
          analystCalls++;
          if (body.messages.at(-1)?.role === 'user') sendToolCall(response, `run-${analystCalls}`, 'start_project', {});
          else sendFinalMessage(response, 'Run requested.');
          return;
        }
        requests.push(body); calls++;
        if (phase === 0) {
          if (calls === 1) sendToolCall(response, 'untouched-first', 'emit_result', { outcome: 'blocked', summary: 'Must not be accepted.' });
          else held.response = response; // Abort this exact in-flight request through ordinary application close.
        } else if (phase === 1) {
          if (calls === 1) sendToolCall(response, 'author-first', 'write', { path: 'record:///assessment.md?card=project', content: 'Delivered current assessment with evidence.' });
          else sendToolCall(response, 'accept-first', 'emit_result', { outcome: 'blocked', summary: 'Authored first assessment.' });
        } else {
          if (calls === 1) sendToolCall(response, 'untouched-clean', 'emit_result', { outcome: 'blocked', summary: 'Must not export accepted backing.' });
          else if (calls === 2) sendToolCall(response, 'author-clean', 'write', { path: 'record:///assessment.md?card=project', content: 'Reassessed current remaining work.' });
          else sendToolCall(response, 'accept-clean', 'emit_result', { outcome: 'blocked', summary: 'Authored fresh assessment.' });
        }
      } catch (error) { failure = error; response.statusCode = 500; response.end(); }
    });
    const port = await listen(provider);
    const config = productionTestConfig(port, value => {
      value.agents.executor!.record_writes.push('assessment.md');
      value.agents.executor!.prompt = { reference: 'assessment-worker', compactable: true };
      value.card_types.project = {
        permitted_child_types: ['code'],
        records: {
          'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
          'assessment.md': { format: 'markdown', schema: 'assessment.v1', bootstrap: false, initialization: { content: INITIAL, at: ['first_required_entry'] } },
        },
        workflow: {
          notification_recipient: 'executor',
          entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
          nodes: { execute: {
            agent: 'executor', prompt: { reference: 'assess', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true },
            records: { 'assessment.md': { mode: 'continue', gate: 'exists' } },
            record_prompts: [{ record: 'assessment.md', selection: 'effective', presence: 'optional', prompt: { reference: 'changed-record-with-body', compactable: true } }],
            edges: { blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['assessment.md'] } } },
          } },
        },
      };
    });
    async function getRecord() {
      const response = await fetch(`${appOrigin(app!)}/api/cards/project/records/assessment.md`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(200); return (await response.json() as any).record;
    }
    async function runUntilStopped() {
      expect((await postStartProject(appOrigin(app!), TOKEN)).status).toBe(200);
      await waitFor(() => failure !== undefined || (app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'blocked' && app!.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped'), 'scripted scaffold acceptance');
      if (failure) throw failure;
    }
    try {
      writeProductionConfig(root, config);
      const prompts = join(root, '.saivage/config/prompts');
      mkdirSync(join(prompts, 'agents/_shared'), { recursive: true });
      mkdirSync(join(prompts, 'process/project'), { recursive: true });
      writeFileSync(join(prompts, 'agents/_shared/assessment-worker.md'), 'Perform the prepared node within its accepted brief and configured tool authority. Use current record URLs for authorized drafts and the generated contract for results.\n{{contractDescription}}\n');
      writeFileSync(join(prompts, 'process/project/assess.md'), 'Assess the accepted brief against current evidence in assessment.md. Replace starter text with the actual current assessment and remaining work. Return blocked only for the unavailable required external evidence, after authoring this assessment.\n');
      initializeProject(root); app = await startProductionApp(root, TOKEN);
      const cards = app.server.runtimeApplication.cardStore;
      cards.acceptRecord('project', 'brief.md', 'Assess current delivery; required external evidence is unavailable. Record the current assessment and this remaining input.', 'analyst');
      const child = cards.create({ type: 'code', parent: 'project', title: 'Pre-entry author', bootstrap_content: 'Supplied child requirements.', created_by: 'analyst', priority: 0, urgency: 'normal', depends_on: [] });
      expect(cards.readRecordCurrent(child.id, 'status.md')).toMatchObject({ value: { projection: null } });
      cards.acceptRecord(child.id, 'status.md', 'Analyst assessment before entry.', 'analyst');
      expect(cards.readRecordCurrent(child.id, 'brief.md')).toMatchObject({ value: { projection: { accepted: { content: 'Supplied child requirements.', writer_agent: 'runtime:bootstrap' } } } });
      expect(cards.readRecordCurrent('project', 'assessment.md')).toMatchObject({ value: { projection: null } });
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      await waitFor(() => calls === 2 || failure !== undefined, 'corrective operation after untouched seed');
      if (failure) throw failure;
      const initial = await getRecord();
      expect(initial).toMatchObject({ state: 'open', revision: 1, accepted: null, draft: { content: INITIAL, unfilled: true } });
      expect(initial.draft).not.toHaveProperty('seed_sha256');
      expect(JSON.stringify(requests[0])).toContain('"unfilled":true'.replaceAll('"', '\\"'));
      expect(JSON.stringify(requests[1])).toContain('unfilled scaffold');
      expect(cards.readRecordHistory('project', 'assessment.md')).toMatchObject({ value: { catalog: { versions: [] } } });
      await app.stop(); app = null; held.response?.destroy();

      // A newly compiled server adopts replacement config, but continue must use stored seed provenance.
      config.card_types.project!.records['assessment.md']!.initialization!.content = REPLACEMENT;
      writeProductionConfig(root, config); phase = 1; calls = 0;
      const freshProcess = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), '--eval', `
        import { startProductionApp } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'tests/helpers/production-composition-e2e.ts')).href)};
        (async () => {
          const app = await startProductionApp(${JSON.stringify(root)}, ${JSON.stringify(TOKEN)});
          const result = app.server.runtimeApplication.cardStore.readRecordCurrent('project', 'assessment.md');
          await app.stop();
          console.log('RETAINED_SEED=' + JSON.stringify(result));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], { encoding: 'utf8', timeout: 15_000 });
      expect(freshProcess.error).toBeUndefined(); expect(freshProcess.status).toBe(0);
      const retainedLine = freshProcess.stdout.split('\n').find(line => line.startsWith('RETAINED_SEED='));
      expect(JSON.parse(retainedLine!.slice('RETAINED_SEED='.length))).toMatchObject({ value: { projection: { draft: { content: INITIAL }, accepted: null } } });
      expect(calls).toBe(0);
      app = await startProductionApp(root, TOKEN);
      expect(await getRecord()).toEqual(initial);
      await runUntilStopped();
      expect(calls).toBe(2);
      const accepted = await getRecord();
      expect(accepted).toMatchObject({ state: 'closed', draft: null, accepted: { content: 'Delivered current assessment with evidence.', writer_agent: 'executor' } });
      const acceptedVersion = accepted.accepted.source_version;
      await app.stop(); app = null;

      config.card_types.project!.workflow.nodes.execute!.records['assessment.md']!.mode = 'clean';
      config.card_types.project!.records['assessment.md']!.initialization!.at = ['first_required_entry', 'clean_entry'];
      writeProductionConfig(root, config); phase = 2; calls = 0;
      app = await startProductionApp(root, TOKEN);
      await runUntilStopped(); expect(calls).toBe(3);
      const final = await getRecord();
      expect(final).toMatchObject({ state: 'closed', draft: null, accepted: { content: 'Reassessed current remaining work.', writer_agent: 'executor' } });
      const conversation = readConversation(root, cardAgentSessionId('executor', 'project'));
      const seeds = conversation.physicalRows.flatMap(row => row.record_observations ?? []).filter(item => item.observed.record_name === 'assessment.md' && item.observed.selection.kind === 'draft' && item.observed.selection.unfilled);
      expect(seeds.some(item => item.observed.selection.kind === 'draft' && item.observed.selection.accepted_backing?.version === acceptedVersion)).toBe(true);
      expect(JSON.stringify(requests.at(-2))).toContain('unfilled scaffold');
      const history = app.server.runtimeApplication.cardStore.readRecordHistory('project', 'assessment.md');
      expect(history).toMatchObject({ value: { catalog: { versions: [expect.objectContaining({ version: acceptedVersion }), expect.objectContaining({ version: final.accepted.source_version })] } } });
      if (process.env.SAIVAGE_TEST_RECORD_COMPOSITION) writeFileSync(process.env.SAIVAGE_TEST_RECORD_COMPOSITION,
        JSON.stringify({ kind: 'isolated-scripted-fixture-not-provider-quality', requests: requests.map(({ messages }) => messages) }, null, 2));
    } finally {
      held.response?.destroy(); if (app) await app.stop(); await closeServer(provider);
    }
  }, 60_000);
});
