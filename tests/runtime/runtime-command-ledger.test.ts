import { describe, it } from '@jest/globals';

describe.skip('runtime command ledger target contract (Wave 1)', () => {
  it('Wave 1 removes this skip when start_project records running intent and creates or reuses a root run before dispatch', () => {
    // TODO(Wave 1): replace this scaffold with assertions against RuntimeCommand, RuntimeIntent,
    // and root RuntimeRun records once the backend ownership boundary exists.
  });

  it('Wave 1 removes this skip when stop_project records stopped intent and prevents new root dispatch', () => {
    // TODO(Wave 1): assert stopped intent is durable and that runtime continuation does not
    // create fresh root work after an explicit stop_project command.
  });

  it('Wave 1 removes this skip when restart with stopped intent repairs state without dispatching the project planner', () => {
    // TODO(Wave 1): assert startup repair reads runtime intent/run records only and does not
    // consume project directives, card status, or other obsolete kickoff triggers.
  });
});
