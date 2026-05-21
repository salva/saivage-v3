import { describe, it } from '@jest/globals';

describe.skip('runtime activation ledger target contract (Wave 1)', () => {
  it('Wave 1 removes this skip when only an active parent planner run can activate a child card', () => {
    // TODO(Wave 1): assert activate_card validates parent runtime run/session ownership and
    // returns an actionable precondition error when no active parent planner run exists.
  });

  it('Wave 1 removes this skip when duplicate activate_card calls return the same unresolved activation record', () => {
    // TODO(Wave 1): assert idempotency uses the parent run/session, child card, and tool call
    // identity or equivalent request key instead of creating duplicate child runs.
  });

  it('Wave 1 removes this skip when restart repair resumes or resolves unresolved child activation records', () => {
    // TODO(Wave 1): assert runtime startup repair uses durable activation records as the source
    // of truth and does not rebuild child work from status-derived ready queues.
  });
});
