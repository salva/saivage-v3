import { expect, it } from '@jest/globals';
import { executionProductionFixture, executionReport } from '../helpers/execution-production-fixture.js';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readProject } from '../../src/tools/project-file-tools.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { cardAcceptedRecordFile } from '../../src/persistence/layout.js';
import { authoredRecordVersionArtifactSchema } from '../../src/persistence/canonical-record-artifacts.js';
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

it.each([['passed', 0, false], ['failed', 9, false], ['timed_out', 0, true]] as const)(
  'publishes real complete stdout as an independent ordinary record: %s', async (outcome, code, deadline) => {
    const fixture = await executionProductionFixture(code, deadline);
    try {
      await fixture.run();
      const headers = { authorization: `Bearer ${fixture.token}` };
      const get = async (path: string) => {
        const response = await fetch(`${fixture.origin}${path}`, { headers });
        expect(response.status).toBe(200);
        return response.json() as Promise<any>;
      };
      const prefix = '/api/cards/project/records/check-report.md';
      const first = fixture.cards.readRecordCurrent('project', 'check-report.md');
      if (first.kind !== 'found') throw new Error('Expected report');
      const accepted = first.value.projection!.accepted!;
      expect(accepted).toMatchObject({ source_version: 1, content: executionReport,
        size_bytes: Buffer.byteLength(executionReport), content_sha256: createHash('sha256').update(executionReport).digest('hex'),
        author: { kind: 'shell-stdout', action: 'shell.run', node_id: 'check', outcome } });
      expect(accepted.content).not.toContain('DISTINCT-STDERR-ONLY');
      const firstArtifact = authoredRecordVersionArtifactSchema.parse(JSON.parse(readFileSync(cardAcceptedRecordFile(fixture.root, 'project', accepted.source_entry_id), 'utf8')));
      expect(firstArtifact.predecessor).toBeNull();
      if (accepted.author.kind !== 'shell-stdout') throw new Error('Expected stdout author');
      const capture = join(fixture.root, '.saivage/work/cards/project/processes', accepted.author.process_id, 'stdout.log');
      expect(readFileSync(capture)).toEqual(Buffer.from(executionReport));
      const current = await get(prefix);
      expect(current.record.accepted.author).toEqual(accepted.author);
      expect(current.record.accepted.content).toBe(redactTextForOutbound(executionReport));
      expect(JSON.stringify(current)).not.toContain('stdout-record-private-canary');
      const file = await get(`/api/files/content?path=${encodeURIComponent('.saivage/cards/project/check-report.md')}`);
      expect(file.content).toBe(redactTextForOutbound(executionReport));
      expect(JSON.stringify(file)).not.toContain('stdout-record-private-canary');
      const history = await get(`${prefix}/versions/1`);
      const diff = await get(`${prefix}/diff?from=1&to=current`);
      const context = { projectRoot: fixture.root, store: fixture.cards, agentName: 'planner', cardId: 'project' };
      for (const path of ['record:///check-report.md?card=project', 'record:///check-report.md?card=project&v=1']) {
        expect((await readProject(context, { path })).data).toMatchObject({ content_author: accepted.author });
      }
      writeFileSync(capture, 'Changed disposable capture only');
      expect(await get(`${prefix}/versions/1`)).toEqual(history);
      unlinkSync(capture);
      expect(await get(prefix)).toEqual(current);
      expect(await get(`${prefix}/diff?from=1&to=current`)).toEqual(diff);
      if (!deadline) {
        fixture.cards.setStatus('project', 'changed');
        await fixture.run();
        const second = fixture.cards.readRecordCurrent('project', 'check-report.md');
        if (second.kind !== 'found') throw new Error('Expected second report');
        expect(second.value.projection!.accepted).toMatchObject({ content: executionReport, source_version: 2,
          content_sha256: accepted.content_sha256, size_bytes: accepted.size_bytes });
        expect(second.value.projection!.headId).not.toBe(first.value.projection!.headId);
        expect(second.value.projection!.accepted!.source_entry_id).not.toBe(accepted.source_entry_id);
        expect(second.value.projection!.accepted!.author).not.toEqual(accepted.author);
        const secondArtifact = authoredRecordVersionArtifactSchema.parse(JSON.parse(readFileSync(cardAcceptedRecordFile(fixture.root, 'project', second.value.projection!.accepted!.source_entry_id), 'utf8')));
        expect(secondArtifact.predecessor).toMatchObject({ entry_id: accepted.source_entry_id, version: 1 });
        expect((await readProject(context, { path: 'record:///check-report.md?card=project' })).data).toMatchObject({ content_author: second.value.projection!.accepted!.author, accepted_version_url: 'record:///check-report.md?card=project&v=2', revision: second.value.projection!.revision });
        expect((await readProject(context, { path: 'record:///check-report.md?card=project&v=2' })).data).toMatchObject({ content_author: second.value.projection!.accepted!.author, version: 2, revision: null, head_id: null });
        expect(await get(`${prefix}/diff?from=1&to=2`)).toMatchObject({ hunks: [] });
        expect(await get(`${prefix}/history`)).toMatchObject({ total: 2, versions: [{ version: 1 }, { version: 2 }] });
        expect(await get(`${prefix}/versions/1`)).toEqual(history);
        expect((await readProject(context, { path: 'record:///check-report.md?card=project&v=1' })).data).toMatchObject({ content_author: accepted.author });
      }
      fixture.cards.openRecord('project', 'check-report.md');
      expect((await readProject(context, { path: 'record:///check-report.md?card=project', metadata_only: true })).data).toMatchObject({ content_author: null });
      expect(readConversation(fixture.root, 'agent:planner:project').physicalRows.filter(row => row.kind === 'tool_result').every(row => row.tool === 'emit_result')).toBe(true);
    } finally { await fixture.close(); }
  }, 60_000,
);
