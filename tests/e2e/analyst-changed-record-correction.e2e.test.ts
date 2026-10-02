import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { loggedToolCallIdentity, loggedToolResultIdentity } from '../../src/schemas/message-identity.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'changed-record-production-e2e-token';
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const briefUrl = 'record:///brief.md?card=project';
const initial = '# Goal\nOld objective.\n\nNever use the corrected approach.';
const intermediate = initial.replace('Old objective.', 'Corrected objective.');
const second = intermediate.replace('\n\nNever use the corrected approach.', '');
const finalBrief = '# Goal\nUse the corrected approach.\n\n# Acceptance Criteria\nVerify current behavior.';
const finalStatus = '# Status\nCorrection complete; execution remains stopped.';
const corrections = [
  { id: 'first-edit', name: 'edit', args: { path: briefUrl, old_string: 'Old objective.', new_string: 'Corrected objective.' }, record: 'brief.md', content: intermediate },
  { id: 'second-edit', name: 'edit', args: { path: briefUrl, old_string: '\n\nNever use the corrected approach.', new_string: '' }, record: 'brief.md', content: second },
  { id: 'replace-brief', name: 'write', args: { path: briefUrl, content: finalBrief }, record: 'brief.md', content: finalBrief },
  { id: 'write-status', name: 'write', args: { path: 'record:///status.md?card=project', content: finalStatus }, record: 'status.md', content: finalStatus },
];

describe('Analyst corrections on CHANGED in production composition', () => {
  it('finishes independent edits and writes in the same stopped app after an ordinary BLOCKED result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-changed-record-e2e-')); roots.push(root);
    let app: App | null = null; let fixtureFailure: unknown;
    let analystCalls = 0; let cardCalls = 0; let correcting = false; let correctionTurns = 0;
    const acceptedHeads: number[] = [];
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        const tools = offeredToolNames(body);
        if (tools.includes('start_project')) {
          analystCalls++;
          if (!correcting) {
            if (analystCalls === 1) sendToolCall(response, 'seed-brief', 'write', { path: briefUrl, content: initial });
            else if (analystCalls === 2) {
              expect(JSON.parse(body.messages.at(-1)!.content)).toMatchObject({ success: true });
              sendToolCall(response, 'start', 'start_project', {});
            } else if (analystCalls === 3) sendFinalMessage(response, 'Started.');
            else throw new Error('Unexpected setup Analyst turn.');
            return;
          }
          const cards = app!.server.runtimeApplication.cardStore;
          expect(app!.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
          expect(cardCalls).toBe(2);
          if (correctionTurns > 0) {
            const previous = corrections[correctionTurns - 1]!; const last = body.messages.at(-1)!;
            expect(last.tool_call_id).toBe(previous.id);
            const result = JSON.parse(last.content);
            expect(result).toMatchObject({ success: true, data: { state: 'closed', propagation: { ok: true } } });
            const current = cards.readRecordCurrent('project', previous.record);
            expect(current).toMatchObject({ kind: 'found', value: { projection: { revision: result.data.revision, state: 'closed', accepted: { content: previous.content, writer_agent: 'analyst' } } } });
            expect(result.data.accepted_version_url).toBe(`record:///${previous.record}?card=project&v=${result.data.revision}`);
            expect(result.data.current_url).toBe(`record:///${previous.record}?card=project`);
            expect(result.data).not.toHaveProperty('head_entry_id');
            if (previous.record === 'brief.md') acceptedHeads.push(result.data.revision);
            expect(cards.read('project')!.lifecycle.status).toBe('changed');
          } else expect(cards.read('project')!.lifecycle.status).toBe('blocked');
          const next = corrections[correctionTurns++];
          if (next) sendToolCall(response, next.id, next.name, next.args);
          else sendFinalMessage(response, 'All corrections accepted without Run.');
          return;
        }
        expect(correcting).toBe(false);
        expect(tools).toEqual(expect.arrayContaining(['write', 'emit_result']));
        cardCalls++;
        if (cardCalls === 1) sendToolCall(response, 'blocked-status', 'write', { path: 'record:///status.md?card=project', content: '# Status\nBlocked pending objective correction.' });
        else if (cardCalls === 2) {
          expect(JSON.parse(body.messages.at(-1)!.content)).toMatchObject({ success: true });
          sendToolCall(response, 'blocked-result', 'emit_result', { outcome: 'blocked', summary: 'Objective needs correction.' });
        } else throw new Error('Unexpected card provider work.');
      } catch (error) { fixtureFailure = error; response.statusCode = 500; response.end(); }
    });
    const port = await listen(provider);
    try {
      const config = productionTestConfig(port, (value) => {
        value.agents.analyst!.record_writes = ['brief.md', 'status.md'];
        value.card_types.project = {
          permitted_child_types: [],
          records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true }, 'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false } },
          workflow: {
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: { blocked: { target: { terminal: 'BLOCKED', promote: 'current', export_records: ['status.md'] } } } } },
          },
        };
      });
      writeProductionConfig(root, config); initializeProject(root); app = await startProductionApp(root, TOKEN);
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      const cards = app.server.runtimeApplication.cardStore;
      await waitFor(() => fixtureFailure !== undefined || (cards.read('project')?.lifecycle.status === 'blocked' && app!.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped'), 'ordinary blocked settlement');
      if (fixtureFailure) throw fixtureFailure;
      const activationRows = readConversation(root, 'agent:executor:project').physicalRows;
      expect(activationRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
      correcting = true;
      const response = await fetch(`${appOrigin(app)}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Correct the objective, remove the stale restriction, replace the brief and update status. Do not Run.' }) });
      expect(response.status).toBe(200); await response.json();
      if (fixtureFailure) throw fixtureFailure;
      expect(correctionTurns).toBe(5); expect(cardCalls).toBe(2); expect(analystCalls).toBe(8);
      expect(acceptedHeads).toHaveLength(3); expect(acceptedHeads[1]).toBeGreaterThan(acceptedHeads[0]!); expect(acceptedHeads[2]).toBeGreaterThan(acceptedHeads[1]!);
      expect(cards.read('project')!.lifecycle.status).toBe('changed');
      expect(app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
      expect(cards.readRecordCurrent('project', 'brief.md')).toMatchObject({ kind: 'found', value: { projection: { accepted: { content: finalBrief } } } });
      for (const [index, head] of acceptedHeads.entries()) {
        expect(cards.readRecordVersion('project', 'brief.md', head)).toMatchObject({ kind: 'found', value: { projection: { artifact: { accepted: { content: corrections[index]!.content } } } } });
      }
      expect(readConversation(root, 'agent:executor:project').physicalRows).toEqual(activationRows);
      const rows = readConversation(root, 'agent:analyst:global').physicalRows;
      for (const correction of corrections) {
        const calls = rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === correction.id);
        const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === correction.id);
        expect(calls).toHaveLength(1); expect(results).toHaveLength(1);
        expect(loggedToolResultIdentity(results[0]!)).toEqual(loggedToolCallIdentity(calls[0]!));
        expect(JSON.parse(results[0]!.content)).toMatchObject({ success: true, data: { propagation: { ok: true } } });
        expect(rows.indexOf(results[0]!)).toBeGreaterThan(rows.indexOf(calls[0]!));
      }
    } finally { if (app) await app.stop(); await closeServer(provider); }
  }, 60_000);
});
