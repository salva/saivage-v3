import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames, postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage, sendToolCall, startProductionApp, waitFor, writeProductionConfig } from '../helpers/production-composition-e2e.js';

// Disposable real-owner regressions: refuse old review, preserve legitimate authorship,
// and finish through ordinary nonterminal close and fresh independent review.
// No mocked grants, acceptance owners, actor settlement, or workflow compiler.
const TOKEN = 'synthetic-assignment-applicability';
const A = '# Goal\nDeliver X (assignment A).';
const B = '# Goal\nDeliver X and Y (assignment B).';
const OLD_REVIEW = 'X satisfies assignment A.';
const brief = 'record:///brief.md?card=project';
const status = 'record:///status.md?card=project';

describe('real classic own-assignment review applicability', () => {
  it.each(['A', 'B', 'C'] as const)('%s: refuses old promotion before effects and completes after fresh review', async (scenario) => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/assignment-review-baseline-');
    let app: App | null = null;
    let failure: unknown;
    let analyst = 0;
    let turn = 0;
    let correcting = false;
    let correctionTurn = 0;
    let consumedNotification = false;
    let pendingNotificationRefusals = 0;
    let assignmentRefusals = 0;
    const selections: Array<{ turn: number; ordinary: unknown; bootstrap: { source_entry_id: string; source_version: number; content: string } }> = [];
    const evidence: unknown[] = [];
    const steps: Array<[string, string, object]> = [
      ['plan-status', 'write', { path: status, content: '# Status\nReady for review A.' }],
      ['plan-result', 'emit_result', { outcome: 'admit_review', summary: 'Review assignment A.' }],
      ['review-write', 'write', { path: 'record:///review.md?card=project', content: '# Review\n' + OLD_REVIEW }],
      ['review-result', 'emit_result', { outcome: 'approved', summary: OLD_REVIEW }],
      ...(scenario !== 'A' ? [['self-brief', 'write', { path: brief, content: B }] as [string, string, object]] : []),
      ['assessment-status', 'write', { path: status, content: '# Status\nAssessing assignment B.' }],
      ...(scenario === 'B' ? [
        ['assessment-replan', 'emit_result', { outcome: 'replan', summary: 'Accept B through ordinary nonterminal close.' }],
        ['replan-status', 'write', { path: status, content: '# Status\nReturn to assessment without review.' }],
        ['replan-result', 'emit_result', { outcome: 'assess_completion', summary: 'Assess B.' }],
        ['final-status', 'write', { path: status, content: '# Status\nComplete under B using prior review.' }],
      ] as Array<[string, string, object]> : []),
      ['terminal-result', 'emit_result', { outcome: 'complete_reviewed', summary: 'New assessment B, not the promoted summary.' }],
      ...(scenario === 'A' ? [
        ['post-notice-status', 'write', { path: status, content: '# Status\nConsumed Analyst assignment-change notice; assess B using prior review A.' }],
        ['post-notice-terminal', 'emit_result', { outcome: 'complete_reviewed', summary: 'Assessment after actual notification consumption.' }],
      ] as Array<[string, string, object]> : []),
    ];
    const recoveryTurn = steps.length;
    steps.push(
      ['accept-and-replan', 'emit_result', { outcome: 'replan', summary: 'Accept assignment B through ordinary nonterminal settlement.' }],
      ['fresh-plan-status', 'write', { path: status, content: '# Status\nAssignment B accepted; obtain independent review.' }],
      ['fresh-plan-review', 'emit_result', { outcome: 'admit_review', summary: 'Review assignment B.' }],
      ['fresh-review-write', 'write', { path: 'record:///review.md?card=project', content: '# Review\nX and Y satisfy assignment B.' }],
      ['fresh-review-result', 'emit_result', { outcome: 'approved', summary: 'X and Y satisfy assignment B.' }],
      ['fresh-assessment-status', 'write', { path: status, content: '# Status\nAssignment B has fresh independent review.' }],
      ['fresh-terminal-result', 'emit_result', { outcome: 'complete_reviewed', summary: 'Promote fresh review B.' }],
    );
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request);
        const tools = offeredToolNames(body);
        const last = body.messages.at(-1);
        if (last?.role === 'tool') {
          const result = JSON.parse(last.content);
          evidence.push({ tool: last.tool_call_id, result });
          expect(result).toMatchObject({ success: true });
        }
        if (tools.includes('start_project')) {
          if (correcting) {
            if (correctionTurn++ === 0) sendToolCall(response, 'analyst-B', 'write', { path: brief, content: B });
            else if (correctionTurn === 2) {
              expect(app!.server.runtimeApplication.runtimeApi.getStatus().status).toBe('paused');
              evidence.push({ pausedAfterAcceptance: app!.server.runtimeApplication.cardStore.read('project'), bootstrap: app!.server.runtimeApplication.cardStore.readRecordCurrent('project', 'brief.md') });
              sendToolCall(response, 'resume-same-Run', 'resume_runtime', {});
            } else sendFinalMessage(response, 'Accepted B and resumed the same Run.');
            return;
          }
          analyst++;
          if (analyst === 1) sendToolCall(response, 'seed-A', 'write', { path: brief, content: A });
          else if (analyst === 2) sendToolCall(response, 'start', 'start_project', {});
          else sendFinalMessage(response, 'Started.');
          return;
        }
        if (scenario === 'A' && turn === 4) app!.server.runtimeApplication.runtimeApi.pause();
        if (scenario === 'A' && turn === 6) {
          const refusal = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'terminal-result');
          expect(JSON.parse(refusal.content)).toMatchObject({ success: false, data: { reason: 'pending_notifications' } });
          pendingNotificationRefusals++;
          consumedNotification = body.messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content === 'Card changed: Analyst updated brief.md');
          expect(consumedNotification).toBe(true);
          evidence.push({ notificationCorrection: body.messages.slice(body.messages.indexOf(refusal)) });
        }
        if (turn === recoveryTurn) {
          const failedId = scenario === 'A' ? 'post-notice-terminal' : 'terminal-result';
          const refusal = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === failedId);
          expect(JSON.parse(refusal.content).success).toBe(false);
          assignmentRefusals++;
          const cards = app!.server.runtimeApplication.cardStore;
          expect(cards.read('project')!.lifecycle.status).toBe('running');
          expect(cards.readRecordCurrent('project', 'status.md')).toMatchObject({ kind: 'found', value: { projection: { state: 'open' } } });
          expect(cards.readRecordCurrent('project', 'brief.md')).toMatchObject({ kind: 'found', value: { projection: scenario === 'C'
            ? { state: 'open', accepted: { content: A }, draft: { content: B } }
            : { state: 'closed', accepted: { content: B } } } });
          expect(readConversation(root, 'agent:reviewer:project').physicalRows.filter(row => row.kind === 'tool_call')).toHaveLength(2);
          evidence.push({ assignmentCorrection: body.messages });
        }
        const inspection = app!.server.runtimeApplication.cardStore.readCardInspectionTree('project', 12);
        const bootstrap = app!.server.runtimeApplication.cardStore.readRecordCurrent('project', 'brief.md');
        if (inspection.kind !== 'found' || bootstrap.kind !== 'found' || !bootstrap.value.projection?.accepted) throw new Error('Required synthetic selections missing.');
        selections.push({ turn, ordinary: inspection.value[0]!.ordinary, bootstrap: bootstrap.value.projection.accepted });
        evidence.push({ turn, ordinary: app!.server.runtimeApplication.cardStore.read('project'), bootstrap: app!.server.runtimeApplication.cardStore.readRecordCurrent('project', 'brief.md') });
        const step = steps[turn++];
        if (!step) {
          console.log(JSON.stringify({ scenario, blockedTrace: body.messages, evidence }, null, 2));
          throw new Error('Unexpected extra card turn (a real admission/correction gate may have refused the proposed trace).');
        }
        sendToolCall(response, ...step);
      } catch (error) { failure = error; response.statusCode = 500; response.end(); }
    });
    try {
      const port = await listen(provider);
      const config = productionTestConfig(port, value => {
        for (const grant of scenario === 'A' ? [] : value.agents.planner!.capabilities.grants) {
          if (grant.tools.includes('write') || grant.tools.includes('edit')) grant.resources!.push({ kind: 'record', scopes: ['self'], patterns: ['brief.md'] });
        }
      });
      writeProductionConfig(root, config);
      initializeProject(root);
      app = await startProductionApp(root, TOKEN);
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      if (scenario === 'A') {
        await waitFor(() => failure !== undefined || app!.server.runtimeApplication.runtimeApi.getStatus().status === 'paused', 'settled supported pause');
        if (failure) throw failure;
        correcting = true;
        const response = await fetch(`${appOrigin(app)}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Accept assignment B and resume this same Run.' }) });
        expect(response.status).toBe(200);
        await response.json();
      }
      await waitFor(() => failure !== undefined || app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'done', 'real terminal promotion');
      if (failure) throw failure;
      const cards = app.server.runtimeApplication.cardStore;
      expect(assignmentRefusals).toBe(1);
      expect(cards.read('project')!.lifecycle).toMatchObject({ status: 'done', result: { executor: { kind: 'agent', agent: 'reviewer' }, node_id: 'review', outcome: 'approved', summary: 'X and Y satisfy assignment B.' } });
      expect(cards.readRecordCurrent('project', 'brief.md')).toMatchObject({ kind: 'found', value: { projection: { state: 'closed', accepted: { content: B } } } });
      const atReview = selections.find(selection => selection.turn === 2)!;
      expect(atReview.bootstrap.content).toBe(A);
      for (const selection of selections.filter(selection => selection.turn >= 2)) expect(selection.ordinary).toEqual(atReview.ordinary);
      const finalBootstrap = cards.readRecordCurrent('project', 'brief.md');
      if (finalBootstrap.kind !== 'found' || !finalBootstrap.value.projection) throw new Error('Final bootstrap missing.');
      expect(finalBootstrap.value.projection.accepted!.source_entry_id).not.toBe(atReview.bootstrap.source_entry_id);
      expect(finalBootstrap.value.projection.accepted!.source_version).toBeGreaterThan(atReview.bootstrap.source_version);
      const rows = readConversation(root, 'agent:reviewer:project').physicalRows;
      expect(rows.filter(row => row.kind === 'tool_call')).toHaveLength(4);
      expect(rows.filter(row => row.kind === 'tool_call' && row.tool_call_id === 'review-result')).toHaveLength(1);
      if (scenario === 'A') { expect(consumedNotification).toBe(true); expect(pendingNotificationRefusals).toBe(1); }
      if (process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE) writeFileSync(
        join(process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE, `assignment-${scenario}.json`),
        JSON.stringify({ scenario, terminal: cards.read('project'), consumedNotification, pendingNotificationRefusals, assignmentRefusals, selections, finalBootstrap, evidence }, null, 2),
      );
    } finally {
      if (app) await app.stop();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('reprepares the same current review when paused Analyst acceptance changes its own assignment', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/assignment-current-review-');
    let app: App | null = null;
    let failure: unknown;
    let analyst = 0;
    let turn = 0;
    let correcting = false;
    let correctionTurn = 0;
    let staleCorrections = 0;
    let notices = 0;
    const evidence: unknown[] = [];
    const steps: Array<[string, string, object]> = [
      ['current-plan-status', 'write', { path: status, content: '# Status\nReady for A review.' }],
      ['current-plan-review', 'emit_result', { outcome: 'admit_review', summary: 'Review A.' }],
      ['current-old-write', 'write', { path: 'record:///review.md?card=project', content: '# Review\n' + OLD_REVIEW }],
      ['current-stale-result', 'emit_result', { outcome: 'approved', summary: OLD_REVIEW }],
      ['current-fresh-write', 'write', { path: 'record:///review.md?card=project', content: '# Review\nB is now reviewed.' }],
      ['current-fresh-result', 'emit_result', { outcome: 'approved', summary: 'B is now reviewed.' }],
      ['current-assess-status', 'write', { path: status, content: '# Status\nFresh review B accepted.' }],
      ['current-first-terminal', 'emit_result', { outcome: 'complete_reviewed', summary: 'Promote B.' }],
    ];
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request);
        if (offeredToolNames(body).includes('start_project')) {
          if (correcting) {
            if (correctionTurn++ === 0) sendToolCall(response, 'current-analyst-B', 'write', { path: brief, content: B });
            else if (correctionTurn === 2) {
              expect(app!.server.runtimeApplication.runtimeApi.getStatus().status).toBe('paused');
              sendToolCall(response, 'current-resume', 'resume_runtime', {});
            } else sendFinalMessage(response, 'Resumed.');
          } else if (++analyst === 1) sendToolCall(response, 'current-seed-A', 'write', { path: brief, content: A });
          else if (analyst === 2) sendToolCall(response, 'current-start', 'start_project', {});
          else sendFinalMessage(response, 'Started.');
          return;
        }
        const cards = app!.server.runtimeApplication.cardStore;
        if (turn === 2) app!.server.runtimeApplication.runtimeApi.pause();
        if (turn === 4) {
          const refusal = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'current-stale-result');
          expect(JSON.parse(refusal.content).success).toBe(false);
          staleCorrections++;
          expect(cards.read('project')!.lifecycle.status).toBe('running');
          expect(cards.readRecordCurrent('project', 'review.md')).toMatchObject({ kind: 'found', value: { projection: { state: 'open', accepted: null, draft: { content: '' } } } });
          evidence.push({ currentReviewCorrection: body.messages });
        }
        if (turn === 6) {
          expect(body.messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content === 'Card changed: Analyst updated brief.md')).toBe(true);
          notices++;
        }
        const step = steps[turn++];
        if (!step) throw new Error('Unexpected current-review correction.');
        sendToolCall(response, ...step);
      } catch (error) { failure = error; response.statusCode = 500; response.end(); }
    });
    try {
      const port = await listen(provider);
      writeProductionConfig(root, productionTestConfig(port)); initializeProject(root);
      app = await startProductionApp(root, TOKEN);
      expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
      await waitFor(() => failure !== undefined || app!.server.runtimeApplication.runtimeApi.getStatus().status === 'paused', 'current-review pause');
      if (failure) throw failure;
      correcting = true;
      const response = await fetch(`${appOrigin(app)}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Accept B and resume the same Run.' }) });
      expect(response.status).toBe(200); await response.json();
      await waitFor(() => failure !== undefined || app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'done', 'fresh current review completion');
      if (failure) throw failure;
      expect(staleCorrections).toBe(1); expect(notices).toBe(1);
      expect(app.server.runtimeApplication.cardStore.read('project')!.lifecycle.result).toMatchObject({ executor: { agent: 'reviewer' }, node_id: 'review', summary: 'B is now reviewed.' });
      const reviews = app.server.runtimeApplication.cardStore.readRecordHistory('project', 'review.md');
      expect(reviews.kind === 'found' && reviews.value.catalog.versions).toHaveLength(1);
      if (process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE) writeFileSync(
        join(process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE, 'assignment-current-review.json'),
        JSON.stringify({ scenario: 'current-review', staleCorrections, evidence }, null, 2),
      );
    } finally { if (app) await app.stop(); await closeServer(provider); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
