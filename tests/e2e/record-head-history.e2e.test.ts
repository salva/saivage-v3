import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import {
  appOrigin,
  closeServer,
  createServer,
  initializeProject,
  listen,
  offeredToolNames,
  postStartProject,
  productionTestConfig,
  readJsonRequest,
  sendFinalMessage,
  sendToolCall,
  startProductionApp,
  waitFor,
  writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const TOKEN = 'record-head-disposable-e2e-token';
describe('new-format record publication, current/history API and restart', () => {
  it('keeps unfinished current draft across restart and accepts it only during explicit authorized Run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-record-head-e2e-'));
    roots.push(root);
    let app: App | null = null;
    let fixtureFailure: unknown;
    let analystCalls = 0;
    let cardCalls = 0;
    const provider = createServer(async (request, response) => {
      try {
        const body = (await readJsonRequest(request)) as ChatCompletionRequest;
        if (offeredToolNames(body).includes('start_project')) {
          analystCalls++;
          if (analystCalls === 1) sendToolCall(response, 'explicit-run', 'start_project', {});
          else sendFinalMessage(response, 'Run requested.');
          return;
        }
        cardCalls++;
        if (cardCalls === 1)
          sendToolCall(response, 'finish-draft', 'edit', {
            path: 'record:///status.md?card=project',
            old_string: 'unfinished',
            new_string: 'finished',
          });
        else
          sendToolCall(response, 'settle-blocked', 'emit_result', {
            outcome: 'blocked',
            summary: 'Record accepted.',
          });
      } catch (error) {
        fixtureFailure = error;
        response.statusCode = 500;
        response.end();
      }
    });
    const port = await listen(provider);
    const get = async (path: string) => {
      const response = await fetch(`${appOrigin(app!)}${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      return { status: response.status, body: (await response.json()) as any };
    };
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
            entries: {
              BACKLOG: { node: 'execute' },
              CHANGED: { node: 'execute' },
              BLOCKED: { node: 'execute' },
              STOPPED: {
                node: 'execute',
                prompt: { reference: 'stopped-recovery', compactable: true },
              },
            },
            nodes: {
              execute: {
                agent: 'executor',
                prompt: { reference: 'execute', compactable: true },
                correction_prompt: { reference: 'correct-execution-result', compactable: true },
                records: { 'status.md': { mode: 'continue', gate: 'updated' } },
                edges: {
                  blocked: {
                    target: {
                      terminal: 'BLOCKED',
                      promote: 'current',
                      export_records: ['status.md'],
                    },
                  },
                },
              },
            },
          },
        };
      });
      writeProductionConfig(root, config);
      initializeProject(root);
      app = await startProductionApp(root, TOKEN);
      const cards = app.server.runtimeApplication.cardStore;
      cards.acceptRecord('project', 'status.md', 'accepted baseline', 'analyst');
      cards.openRecord('project', 'status.md');
      cards.editRecord('project', 'status.md', 'unfinished work');
      const before = await get('/api/cards/project/records/status.md');
      expect(before).toMatchObject({
        status: 200,
        body: {
          record: {
            revision: 3,
            state: 'open',
            current_url: 'record:///status.md?card=project',
            accepted_version_url: 'record:///status.md?card=project&v=1',
            draft: { content: 'unfinished work' },
            accepted: {
              content: 'accepted baseline',
              card_version_seq: 1,
              card_history_version: 1,
            },
          },
        },
      });
      expect(before.body.record).not.toHaveProperty('head_entry_id');
      expect(await get('/api/cards/project/records/status.md/history')).toMatchObject({
        status: 200,
        body: { total: 1, versions: [{ version: 1 }] },
      });
      expect(await get('/api/cards/project/records/status.md/versions/2')).toMatchObject({
        status: 404,
        body: { error: 'historical_version_not_found', version: 2 },
      });
      expect(
        await get('/api/cards/project/records/status.md/diff?from=1&to=current'),
      ).toMatchObject({
        status: 200,
        body: {
          to: { kind: 'current', revision: 3, accepted_version: 1 },
          hunks: [{ lines: ['-accepted baseline', '+unfinished work'] }],
        },
      });
      await app.stop();
      app = await startProductionApp(root, TOKEN);
      expect(await get('/api/cards/project/records/status.md')).toEqual(before);
      expect(cardCalls).toBe(0);
      expect(analystCalls).toBe(0);
      expect(app.server.runtimeApplication.runtimeApi.getStatus().status).toBe('stopped');
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      const restartedCards = app.server.runtimeApplication.cardStore;
      await waitFor(
        () =>
          fixtureFailure !== undefined ||
          (restartedCards.read('project')?.lifecycle.status === 'blocked' &&
            app!.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped'),
        'explicit Run record settlement',
      );
      if (fixtureFailure) throw fixtureFailure;
      expect(cardCalls).toBe(2);
      expect(await get('/api/cards/project/records/status.md')).toMatchObject({
        status: 200,
        body: {
          record: {
            revision: 5,
            state: 'closed',
            draft: null,
            accepted_version_url: 'record:///status.md?card=project&v=5',
            accepted: { content: 'finished work', writer_agent: 'executor' },
          },
        },
      });
      expect(await get('/api/cards/project/records/status.md/history')).toMatchObject({
        status: 200,
        body: { total: 2, versions: [{ version: 1 }, { version: 5 }] },
      });
      expect(await get('/api/cards/project/records/status.md/versions/1')).toMatchObject({
        status: 200,
        body: {
          version_url: 'record:///status.md?card=project&v=1',
          artifact: { accepted: { content: 'accepted baseline' } },
        },
      });
      expect(await get('/api/cards/project/records/status.md/versions/3')).toMatchObject({
        status: 404,
        body: { version: 3 },
      });
    } finally {
      if (app) await app.stop();
      await closeServer(provider);
    }
  }, 60_000);
});
