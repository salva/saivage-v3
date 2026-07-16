import { describe, expect, it } from '@jest/globals';
import { buildRuntimeDiagnosticEvent } from '../../src/runtime/runtime-diagnostic-event.js';

describe('buildRuntimeDiagnosticEvent', () => {
  it('builds event-log-ready diagnostic events for direct appends', () => {
    expect(buildRuntimeDiagnosticEvent({ phase: 'startup', error: new Error('reconciled run') })).toEqual({
      kind: 'runtime_diagnostic',
      phase: 'startup',
      error_message: 'reconciled run',
      error_name: 'Error',
    });
  });
});
