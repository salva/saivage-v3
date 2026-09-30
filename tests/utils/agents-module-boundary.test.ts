import { describe, expect, it } from '@jest/globals';

import * as runtimeApi from '../../src/runtime/runtime-api.js';
import { AnalystRuntime, AnalystSession, AnalystTurnBusyError, AnalystWorkspaceContextBudgetError } from '../../src/runtime/actors/analyst-session.js';

describe('runtime Analyst public boundary', () => {
  it('publishes the actual owner declarations and error identities', () => {
    expect(runtimeApi.AnalystRuntime).toBe(AnalystRuntime);
    expect(runtimeApi.AnalystSession).toBe(AnalystSession);
    expect(runtimeApi.AnalystTurnBusyError).toBe(AnalystTurnBusyError);
    expect(runtimeApi.AnalystWorkspaceContextBudgetError).toBe(AnalystWorkspaceContextBudgetError);
  });
});
