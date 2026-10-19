import { expect, it } from '@jest/globals';
import { executionProductionFixture } from '../helpers/execution-production-fixture.js';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { readConversation } from '../../src/persistence/conversation-file.js';

it.each([0, 9])(
  'real server routes actual agent → shell → assessment/repair and postcommit hook, exit %i',
  async (exitCode) => {
    const fixture = await executionProductionFixture(exitCode);
    try {
      await fixture.run();
      const headers = { authorization: `Bearer ${fixture.token}` };
      const request = async (path: string) => fetch(`${fixture.origin}${path}`, { headers });
      const response = await request('/api/cards/project/executions');
      expect(response.status).toBe(200);
      const list = parseOperatorResponse('cards.executions.list', 200, await response.json());
      expect(list.rows.map((row) => row.kind)).toEqual([
        'invocation_started',
        'process_started',
        'invocation_finished',
        'invocation_started',
        'process_started',
        'invocation_finished',
      ]);
      expect(list.rows[0]!.binding).toMatchObject({ kind: 'node', node_id: 'check' });
      expect(list.rows[3]!.binding).toMatchObject({
        kind: 'card-hook',
        status: exitCode ? 'blocked' : 'done',
        committed_card_artifact: { entry_id: expect.any(String), version: expect.any(Number) },
      });
      for (const [index, marker] of [
        [0, 'ACTUAL-ACTION-OUTPUT'],
        [3, 'ACTUAL-HOOK-OUTPUT'],
      ] as const) {
        const invocation = list.rows[index]!.invocation_id;
        const result = await request(`/api/cards/project/executions/${invocation}`);
        expect(result.status).toBe(200);
      const detail = parseOperatorResponse('cards.executions.get', 200, await result.json());
      expect(JSON.stringify(detail)).not.toContain('synthetic-env-not-public');
        expect(detail).toMatchObject({
          operation: 'shell.run',
          completion: 'retained',
          disposition: 'returned',
          leader_exit: { exit_code: index === 0 ? exitCode : 0 },
          process: { group: 'absent', stdout: 'eof', stderr: 'eof' },
        });
        const stdout = detail.files.find((file) => file.label === 'stdout')!;
        const preview = await request(
          `/api/cards/project/executions/${invocation}/files/${stdout.key}`,
        );
        expect((await preview.json()).content).toContain(marker);
        const download = await request(
          `/api/cards/project/executions/${invocation}/files/${stdout.key}/download`,
        );
        expect(download.headers.get('content-disposition')).toContain('attachment');
        expect(await download.text()).toContain(marker);
      }
      expect(fixture.counts().workflowCalls).toBe(2);
      const conversation = readConversation(fixture.root, 'agent:planner:project').physicalRows;
      expect(conversation.some((row) => row.tool === 'emit_result')).toBe(true);
      expect(
        conversation
          .filter((row) => row.kind === 'activity')
          .map((row) => row.content)
          .join('\n'),
      ).toContain(exitCode ? 'repair' : 'assess');
      expect((await request('/api/cards/project/agent-sessions')).status).toBe(200);
    } finally {
      await fixture.close();
    }
  },
  60_000,
);
