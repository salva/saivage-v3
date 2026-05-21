import { describe, it } from '@jest/globals';

describe.skip('actionable error envelope target contract (Waves 1 and 3)', () => {
  it('Wave 1 removes this skip when invalid planner-state values return accepted values and a next action', () => {
    // TODO(Wave 1): assert schema/tool validation returns { code, message, acceptedValues,
    // currentState, nextAction, docsRef } for planner-state errors.
  });

  it('Wave 1 removes this skip when invalid runtime command preconditions return current intent/run context', () => {
    // TODO(Wave 1): assert start_project/stop_project precondition failures include current
    // runtime intent, relevant run ids, and the next valid operator action.
  });

  it('Wave 1 removes this skip when invalid activation preconditions return parent/child context', () => {
    // TODO(Wave 1): assert activate_card failures include parent run/session, child card,
    // missing precondition, and a next valid planner action.
  });

  it('Wave 3 removes this skip when REST and WebSocket API errors use the same actionable envelope', () => {
    // TODO(Wave 3): assert operator API and WebSocket payloads expose the same error envelope
    // as backend runtime/planner-control code without preview-hash compatibility wrappers.
  });
});
