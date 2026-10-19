import { expect, it } from '@jest/globals';
import { recordAuthorSchema } from '../../src/schemas/record-author.js';

const shell = {
  kind: 'shell-stdout', action: 'shell.run', contract_version: 1,
  activation_id: '11111111-1111-4111-8111-111111111111',
  invocation_id: '22222222-2222-4222-8222-222222222222',
  node_id: 'check', ordinal: 0, process_id: 'proc-123456789abc', stream: 'stdout',
  outcome: 'passed', leader_exit: { exit_code: 0, signal: null },
};
it('accepts truthful observed shell dispositions, distinct agent/runtime authors and no legacy author strings', () => {
  for (const author of [
    { kind: 'agent', agent: 'analyst' }, { kind: 'runtime', purpose: 'bootstrap' }, { kind: 'runtime', purpose: 'repair' }, shell,
    { ...shell, outcome: 'failed', leader_exit: { exit_code: 9, signal: null } },
    { ...shell, outcome: 'signalled', leader_exit: { exit_code: null, signal: 'SIGTERM' } },
    { ...shell, outcome: 'timed_out', leader_exit: null },
    { ...shell, outcome: 'timed_out', leader_exit: { exit_code: 0, signal: null } },
  ]) expect(recordAuthorSchema.parse(author)).toEqual(author);
  for (const author of ['analyst', 'runtime:bootstrap', { kind: 'agent', agent: 'analyst', invocation_id: shell.invocation_id },
    { ...shell, outcome: 'passed', leader_exit: null },
    { ...shell, outcome: 'failed' }, { ...shell, outcome: 'signalled' },
    { ...shell, outcome: 'timed_out', leader_exit: { exit_code: 0, signal: 'SIGTERM' } },
    { ...shell, stream: 'stderr' }, { ...shell, process_id: 'arbitrary' }, { ...shell, ordinal: -1 },
  ]) expect(recordAuthorSchema.safeParse(author).success).toBe(false);
});
