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

const TOKEN = 'record-url-production-e2e-token';
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('record URL failures in production composition', () => {
  it('corrects a rejected write and continues after an invalid edit in the same activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-record-url-e2e-')); roots.push(root);
    let app: App | null = null;
    let fixtureFailure: unknown;
    let analystCalls = 0; let cardCalls = 0;
    let beforeBadWrite: unknown; let afterGoodWrite: unknown;
    const currentUrl = 'record:///status.md?card=project';
    const content = '# Status\nCorrected current URL accepted.';
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        const tools = offeredToolNames(body);
        if (tools.includes('start_project')) {
          analystCalls++;
          if (analystCalls === 1) sendToolCall(response, 'start', 'start_project', {});
          else if (analystCalls === 2) sendFinalMessage(response, 'Started.');
          else throw new Error('Unexpected Analyst continuation.');
          return;
        }
        expect(tools).toEqual(expect.arrayContaining(['write', 'edit', 'emit_result']));
        const cards = app!.server.runtimeApplication.cardStore;
        cardCalls++;
        if (cardCalls === 1) {
          beforeBadWrite = cards.readRecordCurrent('project', 'status.md');
          sendToolCall(response, 'bad-write', 'write', { path: 'record:///status.md', content: 'must not be written' });
        } else {
          const last = body.messages.at(-1)!;
          expect(last.role).toBe('tool');
          const result = JSON.parse(last.content);
          if (cardCalls === 2) {
            expect(last.tool_call_id).toBe('bad-write');
            expect(result).toMatchObject({ success: false, data: { code: 'record_mutation_invalid_target', operation: 'write' } });
            expect(cards.readRecordCurrent('project', 'status.md')).toEqual(beforeBadWrite);
            sendToolCall(response, 'good-write', 'write', { path: currentUrl, content });
          } else if (cardCalls === 3) {
            expect(last.tool_call_id).toBe('good-write');
            expect(result).toMatchObject({ success: true, data: { current_url: currentUrl, written: true } });
            afterGoodWrite = cards.readRecordCurrent('project', 'status.md');
            sendToolCall(response, 'bad-edit', 'edit', { path: `${currentUrl}&v=1`, old_string: 'Corrected', new_string: 'must not change' });
          } else if (cardCalls === 4) {
            expect(last.tool_call_id).toBe('bad-edit');
            expect(result).toMatchObject({ success: false, data: { code: 'record_mutation_invalid_target', operation: 'edit' } });
            expect(cards.readRecordCurrent('project', 'status.md')).toEqual(afterGoodWrite);
            sendToolCall(response, 'done', 'emit_result', { outcome: 'done', summary: 'Current URL corrected.' });
          } else throw new Error('Unexpected card continuation.');
        }
      } catch (error) { fixtureFailure = error; response.statusCode = 500; response.end(); }
    });
    const port = await listen(provider);
    try {
      const config = productionTestConfig(port, (value) => {
        value.card_types.project = {
          permitted_child_types: [],
          records: {
            'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true },
            'status.md': { format: 'markdown', schema: 'work-status.v1', bootstrap: false },
          },
          workflow: {
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: { 'status.md': { mode: 'continue', gate: 'updated' } }, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: ['status.md'] } } } } },
          },
        };
      });
      writeProductionConfig(root, config); initializeProject(root);
      app = await startProductionApp(root, TOKEN);
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      const cards = app.server.runtimeApplication.cardStore;
      await waitFor(() => fixtureFailure !== undefined || cards.read('project')?.lifecycle.status === 'done', 'root completion');
      if (fixtureFailure) throw fixtureFailure;
      expect({ analystCalls, cardCalls }).toEqual({ analystCalls: 2, cardCalls: 4 });
      expect(cards.read('project')!.lifecycle.status).toBe('done');
      const record = cards.readRecordCurrent('project', 'status.md');
      expect(record).toMatchObject({ kind: 'found', value: { projection: { artifact: { state: 'closed', accepted: { content } } } } });
      const rows = readConversation(root, 'agent:executor:project').physicalRows;
      const results = rows.filter((row) => row.kind === 'tool_result');
      expect(results.map((row) => row.tool_call_id)).toEqual(['bad-write', 'good-write', 'bad-edit', 'done']);
      expect(results.map((row) => JSON.parse(row.content).success)).toEqual([false, true, false, true]);
      const calls = rows.filter((row) => row.kind === 'tool_call');
      expect(calls.map((row) => row.tool_call_id)).toEqual(results.map((row) => row.tool_call_id));
      expect(calls.map((row) => JSON.parse(JSON.parse(row.content).tool_calls[0].function.arguments))).toEqual([
        { path: 'record:///status.md', content: 'must not be written' },
        { path: currentUrl, content },
        { path: `${currentUrl}&v=1`, old_string: 'Corrected', new_string: 'must not change' },
        { outcome: 'done', summary: 'Current URL corrected.' },
      ]);
      for (const [index, call] of calls.entries()) {
        const result = results[index]!;
        expect(loggedToolResultIdentity(result)).toEqual(loggedToolCallIdentity(call));
        expect(rows.indexOf(result)).toBeGreaterThan(rows.indexOf(call));
        if (index + 1 < calls.length) expect(rows.indexOf(result)).toBeLessThan(rows.indexOf(calls[index + 1]!));
      }
      const markers = rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'));
      expect(markers).toHaveLength(1);
      expect(rows.indexOf(markers[0]!)).toBeLessThan(rows.indexOf(calls[0]!));
    } finally { if (app) await app.stop(); await closeServer(provider); }
  }, 60_000);
});
