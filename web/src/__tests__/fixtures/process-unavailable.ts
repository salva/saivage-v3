import type { ProcessView } from '../../../../src/contracts/index.js';

export const unavailableProcess: ProcessView = {
  id: 'proc-0123456789ab', status: 'unavailable',
  started_at: '2026-10-09T12:00:00.000Z', ended_at: null, exit_code: null,
  timed_out: false, owner_id: 'activation-original', owner_kind: 'agent',
  session_id: 'agent:executor:card-a', card_id: 'card-a', command: 'synthetic command', cwd: '.',
  evidence: {
    group: 'unverifiable', group_diagnostic: 'EPERM: group authority lost',
    leader_exit: { exit_code: 1, signal: null, observed_at: '2026-10-09T12:00:01.000Z' },
    leader_error: null, stdout: 'open', stderr: 'eof',
    stdout_error: 'synthetic stdout capture error', stderr_error: 'synthetic stderr capture error',
  },
  logs: { stdout: 'work:///cards/card-a/processes/proc-0123456789ab/stdout.log', stderr: 'work:///cards/card-a/processes/proc-0123456789ab/stderr.log' },
};
