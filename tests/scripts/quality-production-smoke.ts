import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executionProductionFixture } from '../helpers/execution-production-fixture.js';
import { waitFor } from '../helpers/production-composition-e2e.js';
import { cardAcceptedRecordFile } from '../../src/persistence/layout.js';
import { authoredRecordVersionArtifactSchema } from '../../src/persistence/canonical-record-artifacts.js';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

// Run compiled: actual ProcessRunner loads the packaged native helper, not a
// test replacement. The only provider is the local deterministic HTTP fixture.
if (!process.env.SAIVAGE_QUALITY_NATIVE_ROOT || process.env.NODE_DISABLE_COMPILE_CACHE !== '1')
  throw new Error('Explicit native provisioning and disabled compile cache are required.');
for (const language of ['javascript', 'typescript', 'python'] as const) {
  for (const nativeCase of ['clean', 'defect', 'config-error'] as const) {
    let release!: () => void;
    const assessmentGate = new Promise<void>((resolve) => { release = resolve; });
    let releaseReviewer!: () => void;
    const reviewerGate = new Promise<void>((resolve) => { releaseReviewer = resolve; });
    const cardTool = language === 'javascript' && nativeCase === 'defect';
    const fixture = await executionProductionFixture(0, false, { language, fixture: nativeCase, assessmentGate, reviewerGate, cardTool });
    let running: Promise<void> | undefined;
    let failed = false;
    try {
      running = fixture.run();
      // Attach rejection immediately while observing the held assessment.
      let runError: unknown;
      const settled = running.catch((error: unknown) => { runError = error; });
      await waitFor(() => fixture.assessmentRequest() !== null || runError !== undefined, 'quality assessment reached');
      if (runError) throw runError;
      assert.notEqual(fixture.cards.read('project')!.lifecycle.status, 'done', 'analysis cannot complete without the agent assessment');
      const current = fixture.cards.readRecordCurrent('project', 'check-report.md');
      assert.equal(current.kind, 'found');
      if (current.kind !== 'found') throw new Error('Missing accepted report.');
      const accepted = current.value.projection!.accepted!;
      const expected = nativeCase === 'clean' ? 'clean' : nativeCase === 'defect' ? 'findings' : 'analysis_failed';
      const operation = `code-quality.${language}.${language === 'python' ? 'ruff' : 'eslint'}`;
      assert.equal(accepted.author.kind, 'action-output');
      if (accepted.author.kind !== 'action-output') throw new Error('Wrong report authority.');
      assert.equal(accepted.author.operation, operation);
      assert.equal(accepted.author.outcome, expected);
      const assessmentWire = JSON.stringify(fixture.assessmentRequest());
      assert(assessmentWire.includes('Previous action observation'));
      assert(assessmentWire.includes(operation));
      assert(assessmentWire.includes('record:///check-report.md?card=project&v=1'));
      if (cardTool) {
        const continuation = JSON.stringify(fixture.cardToolContinuation());
        assert(continuation.includes('code_quality_javascript_eslint'));
        assert(continuation.includes('work:///quality/'));
        // The configured card tool analyzes clean.js; the later action analyzes
        // defect.js. Both are real and their bound scopes must stay distinct.
        assert(continuation.includes('clean'));
      } else {
        assert.equal(fixture.cardToolContinuation(), null, 'Default nodes must not invoke optional quality tools');
      }
      assert.equal(accepted.author.output.source, 'returned-text');
      assert(accepted.author.process_id, 'native process identity must be retained');
      assert.match(accepted.content, /not product acceptance/i);
      const artifact = authoredRecordVersionArtifactSchema.parse(JSON.parse(readFileSync(
        cardAcceptedRecordFile(fixture.root, 'project', accepted.source_entry_id), 'utf8')));
      assert.equal(artifact.predecessor, null);
      const headers = { authorization: `Bearer ${fixture.token}` };
      const get = async (path: string) => {
        const response = await fetch(`${fixture.origin}${path}`, { headers });
        assert.equal(response.status, 200, path);
        return response.json();
      };
      assert.equal((await fetch(`${fixture.origin}/api/cards/project/executions`)).status, 401);
      const list = parseOperatorResponse('cards.executions.list', 200, await get('/api/cards/project/executions'));
      assert.equal(list.rows.length, 3);
      const invocation = list.rows[0]!.invocation_id;
      const detail = parseOperatorResponse('cards.executions.get', 200,
        await get(`/api/cards/project/executions/${invocation}`));
      assert.equal(detail.operation, operation);
      assert.equal(detail.process?.group, 'absent');
      assert.equal(detail.process?.stdout, 'eof');
      assert.equal(detail.process?.stderr, 'eof');
      for (const name of ['native.json', 'findings.json', 'metadata.json', 'report.md']) {
        const selected = detail.files.find((file) => file.label.endsWith(name));
        assert(selected, `Missing selected ${name}`);
        const preview = await get(`/api/cards/project/executions/${invocation}/files/${selected.key}`);
        assert.equal(typeof preview.content, 'string');
      }
      const prefix = '/api/cards/project/records/check-report.md';
      const publicCurrent = await get(prefix);
      assert.deepEqual(publicCurrent.record.accepted.author, accepted.author);
      assert.equal(publicCurrent.record.accepted.content, accepted.content);
      const historical = await get(`${prefix}/versions/1`);
      assert(accepted.content.includes(`work:///quality/${invocation}/findings.json`));
      const work = await get(`/api/files/content?path=${encodeURIComponent(`.saivage/work/quality/${invocation}/report.md`)}`);
      assert.equal(work.content, accepted.content);
      release();
      if (nativeCase !== 'config-error') {
        await waitFor(() => fixture.reviewerReadRequest() !== null || runError !== undefined, 'reviewer read after rejected premature approval');
        if (runError) throw runError;
        assert.notEqual(fixture.cards.read('project')!.lifecycle.status, 'done');
        const wire = JSON.stringify(fixture.reviewerReadRequest());
        assert(wire.includes('review-premature'));
        assert(wire.includes('review-read'));
        assert(wire.includes('review.md'));
        assert(wire.includes(operation));
        assert(wire.includes(`work:///quality/${invocation}/findings.json`));
        const beforeReview = fixture.cards.readRecordCurrent('project', 'review.md');
        assert.equal(beforeReview.kind, 'found');
        if (beforeReview.kind !== 'found') throw new Error('Missing review definition');
        assert.equal(beforeReview.value.projection?.accepted ?? null, null);
        releaseReviewer();
      }
      await settled;
      if (runError) throw runError;
      assert.equal(fixture.cards.read('project')!.lifecycle.status, nativeCase === 'config-error' ? 'blocked' : 'done');
      assert.equal(fixture.counts().workflowCalls, nativeCase === 'config-error' ? 2 : 6);
      if (nativeCase !== 'config-error') {
        const review = fixture.cards.readRecordCurrent('project', 'review.md');
        assert.equal(review.kind, 'found');
        if (review.kind !== 'found') throw new Error('Missing accepted review');
        assert.deepEqual(review.value.projection!.accepted!.author, { kind: 'agent', agent: 'reviewer' });
      }
      assert.deepEqual(await get(`${prefix}/versions/1`), historical);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        fixture.app.server.runtimeApplication.processRunner.fatalPort.publicationOutcomeUnknown(error);
      failed = true;
      fixture.captureFailure(error);
      throw error;
    } finally {
      release();
      releaseReviewer();
      if (running) await running.catch(() => undefined);
      await fixture.close(failed);
    }
  }
}
console.log('Nine native quality production cases: accepted report, held assessment, authenticated API and exact work/history evidence passed.');
