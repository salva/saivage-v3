import { expect, it } from '@jest/globals';
import { cardLifecycleStateSchema } from '../../src/schemas/lifecycle.js';
import { workflowResult } from '../helpers/workflow-result.js';

it('accepts exactly agent or action workflow executors and rejects the retained old agent_name contract', () => {
  const result = workflowResult('DONE', 'Observed completion.');
  const lifecycle = { status: 'done', result, error: null, completed_at: '2026-10-19T00:00:00.000Z' };
  expect(cardLifecycleStateSchema.parse(lifecycle)).toEqual(lifecycle);
  const action = { ...result, executor: { kind: 'action', action: 'shell.run', contract_version: 1,
    provider: { kind: 'builtin', name: 'shell' }, invocation_id: '11111111-1111-4111-8111-111111111111' } };
  expect(cardLifecycleStateSchema.parse({ ...lifecycle, result: action })).toMatchObject({ result: action });
  const { executor: _executor, ...old } = result;
  for (const invalid of [
    { ...old, agent_name: 'executor' }, { ...result, agent_name: 'executor' },
    { ...action, executor: { ...action.executor, invocation_id: 'not-an-invocation' } },
    { ...action, executor: { ...action.executor, agent: 'executor' } },
    { ...action, executor: { ...action.executor, values: { exit_code: 0 } } },
  ]) expect(() => cardLifecycleStateSchema.parse({ ...lifecycle, result: invalid })).toThrow();
});
