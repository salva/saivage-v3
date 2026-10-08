import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { loggedToolCallIdentity, loggedToolCallKey, loggedToolResultIdentity } from '../../src/schemas/message-identity.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'card-inspection-id-production-e2e-token';
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card-inspection ID admission in production composition', () => {
  it('settles malformed arguments and corrects them in one DONE activation without replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-id-e2e-')); roots.push(root);
    let app: App | null = null;
    let fixtureFailure: unknown;
    let analystCalls = 0; let cardCalls = 0;
    const badArgs = { id: 'card-s6a7988d', section: 'records', position: { item_index: 0, item_byte_offset: 0 }, response_bytes: 8000 };
    const goodArgs = { ...badArgs, id: 'project' };
    const doneArgs = { outcome: 'done', summary: 'Corrected inspection completed.' };
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
        expect(tools).toEqual(expect.arrayContaining(['get_card', 'emit_result']));
        cardCalls++;
        if (cardCalls === 1) sendToolCall(response, 'bad-inspection', 'get_card', badArgs);
        else {
          const last = body.messages.at(-1)!;
          expect(last.role).toBe('tool');
          const result = JSON.parse(last.content);
          if (cardCalls === 2) {
            expect(last.tool_call_id).toBe('bad-inspection');
            expect(result.success).toBe(false);
            sendToolCall(response, 'good-inspection', 'get_card', goodArgs);
          } else if (cardCalls === 3) {
            expect(last.tool_call_id).toBe('good-inspection');
            expect(result).toMatchObject({ success: true, data: { card_id: 'project', section: 'records' } });
            sendToolCall(response, 'done', 'emit_result', doneArgs);
          } else throw new Error('Unexpected card continuation.');
        }
      } catch (error) { fixtureFailure = error; response.statusCode = 500; response.end(); }
    });
    const port = await listen(provider);
    try {
      const config = productionTestConfig(port, (value) => {
        value.agents.executor!.tools.push('get_card');
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
      writeProductionConfig(root, config); initializeProject(root);
      app = await startProductionApp(root, TOKEN);
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      const cards = app.server.runtimeApplication.cardStore;
      await waitFor(() => fixtureFailure !== undefined || cards.read('project')?.lifecycle.status === 'done', 'root completion');
      if (fixtureFailure) throw fixtureFailure;
      expect({ analystCalls, cardCalls }).toEqual({ analystCalls: 2, cardCalls: 3 });
      expect(cards.read('project')!.lifecycle).toMatchObject({ status: 'done', error: null, result: { summary: doneArgs.summary } });
      const rows = readConversation(root, 'agent:executor:project').physicalRows;
      const calls = rows.filter((row) => row.kind === 'tool_call');
      const results = rows.filter((row) => row.kind === 'tool_result');
      expect(calls.map((row) => row.tool_call_id)).toEqual(['bad-inspection', 'good-inspection', 'done']);
      expect(results.map((row) => row.tool_call_id)).toEqual(calls.map((row) => row.tool_call_id));
      expect(results.map((row) => JSON.parse(row.content).success)).toEqual([false, true, true]);
      expect(calls.map((row) => JSON.parse(JSON.parse(row.content).tool_calls[0].function.arguments))).toEqual([badArgs, goodArgs, doneArgs]);
      for (const [index, call] of calls.entries()) {
        const matches = results.filter((result) => loggedToolCallKey(loggedToolResultIdentity(result)!) === loggedToolCallKey(loggedToolCallIdentity(call)!));
        expect(matches).toHaveLength(1);
        const result = matches[0]!;
        expect(loggedToolResultIdentity(result)).toEqual(loggedToolCallIdentity(call));
        expect(rows.indexOf(result)).toBeGreaterThan(rows.indexOf(call));
        if (index + 1 < calls.length) expect(rows.indexOf(result)).toBeLessThan(rows.indexOf(calls[index + 1]!));
      }
      const markers = rows.filter((row) => row.kind === 'activity' && JSON.parse(row.content).event === 'activation_open');
      expect(markers).toHaveLength(1);
      expect(rows.indexOf(markers[0]!)).toBeLessThan(rows.indexOf(calls[0]!));

      // Stop this isolated app before testing strict consumption of its exact index.
      // No restart, recovery or subsequent tool invocation consumes the damaged fixture.
      await app.stop(); app = null;
      const indexPath = cardConversationVersionIndexFile(root, 'project', 'executor');
      const malformed = '{}\n';
      writeFileSync(indexPath, malformed);
      expect(() => readConversation(root, 'agent:executor:project')).toThrow();
      expect(readFileSync(indexPath, 'utf8')).toBe(malformed);
    } finally { if (app) await app.stop(); await closeServer(provider); }
  }, 60_000);
});
