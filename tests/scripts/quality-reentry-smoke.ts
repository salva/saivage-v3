import assert from 'node:assert/strict';
import { executionProductionFixture } from '../helpers/execution-production-fixture.js';
import { waitFor } from '../helpers/production-composition-e2e.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

if (!process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE)
  throw new Error('Set a fresh SAIVAGE_TEST_COMPOSITION_EVIDENCE directory for actual re-entry wires.');
const fixture = await executionProductionFixture(0, false, {
  language: 'typescript', fixture: 'defect', evidenceTag: 'reentry',
});
let failed = false;
let running: Promise<void> | undefined;
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const acceptedReport = () => {
  const current = fixture.cards.readRecordCurrent('project', 'check-report.md');
  assert.equal(current.kind, 'found');
  if (current.kind !== 'found' || !current.value.projection?.accepted) throw new Error('Missing accepted report');
  return current.value.projection.accepted;
};
const historical = async () => {
  const response = await fetch(`${fixture.origin}/api/cards/project/records/check-report.md/versions/1`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await fixture.run();
  assert.equal(fixture.cards.read('project')!.lifecycle.status, 'done');
  assert.equal(fixture.app.server.runtimeApplication.runtimeApi.getStatus().status, 'stopped');
  const first = acceptedReport();
  assert.equal(first.author.kind, 'action-output');
  if (first.author.kind !== 'action-output') throw new Error('Wrong initial report author');
  const firstHistory = await historical();
  // Natural stopped completion precedes supported Analyst reopen and a separate
  // explicit Run. No direct card/history mutation or fabricated ingress.
  await fixture.reopen();
  assert.equal(fixture.app.server.runtimeApplication.runtimeApi.getStatus().status, 'stopped');
  assert.deepEqual(acceptedReport(), first);
  running = fixture.run(gate);
  let runError: unknown;
  const settled = running.catch((error: unknown) => { runError = error; });
  await waitFor(() => fixture.assessmentRequest() !== null || runError !== undefined, 'new activation assessment');
  if (runError) throw runError;
  const second = acceptedReport();
  assert.equal(second.author.kind, 'action-output');
  if (second.author.kind !== 'action-output') throw new Error('Wrong re-entry report author');
  assert.notEqual(second.author.activation_id, first.author.activation_id);
  assert.notEqual(second.author.invocation_id, first.author.invocation_id);
  assert.notEqual(second.source_entry_id, first.source_entry_id);
  assert.equal(second.author.outcome, 'findings');
  assert.notEqual(fixture.cards.read('project')!.lifecycle.status, 'done');
  const wire = JSON.stringify(fixture.assessmentRequest());
  assert(wire.includes('Previous action observation'));
  assert(wire.includes('record:///check-report.md?card=project&v=2'));
  assert(wire.includes(second.author.invocation_id));
  assert.deepEqual(await historical(), firstHistory);
  release();
  await settled;
  if (runError) throw runError;
  assert.equal(fixture.cards.read('project')!.lifecycle.status, 'done');
  assert.equal(fixture.app.server.runtimeApplication.runtimeApi.getStatus().status, 'stopped');
  const reviewWire = JSON.stringify(fixture.reviewerReadRequest());
  assert(reviewWire.includes('record:///check-report.md?card=project&v=2'));
  assert(reviewWire.includes(second.author.invocation_id));
  assert.deepEqual(await historical(), firstHistory);
  console.log('Actual typed action re-entry: stopped completion, supported reopen/new Run, fresh accepted evidence and held assessment/Reviewer wires passed.');
} catch (error) {
  if (error instanceof PublicationOutcomeUnknownError)
    fixture.app.server.runtimeApplication.processRunner.fatalPort.publicationOutcomeUnknown(error);
  failed = true;
  fixture.captureFailure(error);
  throw error;
} finally {
  release();
  if (running) await running.catch(() => undefined);
  await fixture.close(failed);
}
