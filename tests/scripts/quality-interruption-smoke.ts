import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { executionProductionFixture } from '../helpers/execution-production-fixture.js';
import { postStartProject, waitFor } from '../helpers/production-composition-e2e.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';

for (const mode of ['timeout', 'cancel'] as const) {
  const fixture = await executionProductionFixture(0, mode === 'timeout', {
    language: 'javascript', fixture: 'clean', slowNative: true,
  });
  try {
    if (mode === 'timeout') {
      await fixture.run();
      assert(existsSync(join(fixture.root, 'fixtures/native-entered')));
      assert.equal(fixture.cards.read('project')!.lifecycle.status, 'blocked');
      const current = fixture.cards.readRecordCurrent('project', 'check-report.md');
      assert.equal(current.kind, 'found');
      if (current.kind !== 'found') throw new Error('Missing timeout report');
      const accepted = current.value.projection!.accepted!;
      assert.equal(accepted.author.kind, 'action-output');
      if (accepted.author.kind !== 'action-output') throw new Error('Wrong author');
      assert.equal(accepted.author.outcome, 'timed_out');
      assert(accepted.content.includes('timed_out'));
    } else {
      const before = fixture.cards.readRecordCurrent('project', 'check-report.md');
      assert.equal(before.kind, 'found');
      if (before.kind !== 'found') throw new Error('Missing report definition before cancellation');
      assert.equal(before.value.projection, null, 'Cancellation fixture must begin with no selected report');
      assert.equal((await postStartProject(fixture.origin, fixture.token)).status, 200);
      await waitFor(() => existsSync(join(fixture.root, 'fixtures/native-entered')), 'native action before Stop');
      await fixture.app.server.runtimeApplication.runtimeApi.stopProject();
      await waitFor(() => fixture.app.server.runtimeApplication.runtimeApi.getStatus().status === 'stopped', 'quality Stop settlement');
      const after = fixture.cards.readRecordCurrent('project', 'check-report.md');
      assert.equal(after.kind, 'found');
      if (after.kind !== 'found') throw new Error('Missing report definition after cancellation');
      // The wrapper also includes the card, whose activation legitimately changes
      // lifecycle/revision. Compare the exact record projection, not that card.
      assert.deepEqual(after.value.projection, before.value.projection, 'Cancelled action cannot select a report or draft');
      assert.equal(fixture.assessmentRequest(), null);
    }
    const finish = readCardExecutions(fixture.root, 'project').at(-1)!;
    assert.equal(finish.kind, 'invocation_finished');
    if (finish.kind !== 'invocation_finished') throw new Error('Missing completion');
    assert.equal(finish.disposition, mode === 'timeout' ? 'timed_out' : 'cancelled');
    assert.equal(finish.process?.group, 'absent');
    assert.equal(finish.process?.stdout, 'eof');
    assert.equal(finish.process?.stderr, 'eof');
    assert.equal(fixture.app.server.runtimeApplication.processRunner.list().some((process) => process.status === 'running'), false);
  } finally { await fixture.close(); }
}
console.log('Production quality timeout acceptance and cancelled no-acceptance/assessment boundaries passed.');
