import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  compileOperations,
  type OperationDefinition,
  type OperationFields,
  type OperationValues,
} from '../../src/runtime/card-process/operation-contract.js';
import {
  compileActionExecution,
  resolveExecutionInputs,
  selectOperationRoute,
} from '../../src/runtime/card-process/operation-routing.js';
import { invokeOperation } from '../../src/runtime/actors/operation-execution.js';
import { cleanupTestProcessRunners, createTestProcessRunner } from './test-process-runner.js';

// Opaque synthetic values: no bearer/token/assignment pattern can identify these strings.
export const observationCanaries = {
  input: ['violet-orbit-4826', 'amber-meadow-7319', 'silver-canyon-2058'],
  output: ['indigo-harbor-9462', 'copper-forest-1683', 'ivory-comet-5704'],
} as const;

export const observationInputs = {
  api_token: observationCanaries.input[0],
  access_token: [...observationCanaries.input.slice(1)],
  count_secret: 73,
  enabled_secret: true,
  empty_secret: [],
  label: 'visible-input-control',
  labels: ['visible-input-first', 'visible-input-second'],
  count: 19,
  enabled: true,
  empty: [],
  note: 'api_key: ordinary-input-text-canary',
  notes: ['safe input note', 'api_key: ordinary-input-list-canary'],
} satisfies OperationValues;

export const observationOutputs = {
  api_token: observationCanaries.output[0],
  access_token: [...observationCanaries.output.slice(1)],
  count_secret: 89,
  enabled_secret: true,
  empty_secret: [],
  label: 'visible-output-control',
  labels: ['visible-output-first', 'visible-output-second'],
  count: 23,
  enabled: true,
  empty: [],
  note: 'api_key: ordinary-output-text-canary',
  notes: ['safe output note', 'api_key: ordinary-output-list-canary'],
} satisfies OperationValues;

const fields = {
  api_token: { type: 'string', workflow: true },
  access_token: { type: 'strings', workflow: true },
  count_secret: { type: 'integer', workflow: true },
  enabled_secret: { type: 'boolean', workflow: true },
  empty_secret: { type: 'strings', workflow: true },
  label: { type: 'string', workflow: true },
  labels: { type: 'strings', workflow: true },
  count: { type: 'integer', workflow: true },
  enabled: { type: 'boolean', workflow: true },
  empty: { type: 'strings', workflow: true },
  note: { type: 'string', workflow: true },
  notes: { type: 'strings', workflow: true },
} satisfies OperationFields;

/** Real compiler/invocation/evidence owners, no provider, subprocess or hand-authored log rows. */
export async function invokeObservationPlugin(root: string) {
  const received: OperationValues[] = [];
  const definition: OperationDefinition = {
    id: 'observation.inspect',
    provider: { kind: 'plugin', name: 'observation' },
    contractVersion: 1,
    bindings: ['node'],
    config: z.object({ private: z.string() }).strict(),
    inputs: fields,
    outcomes: { observed: fields },
    retainFields: Object.keys(fields),
    async run(_config, input) {
      received.push(input);
      return { outcome: 'observed', summary: 'Synthetic typed observation.', values: observationOutputs };
    },
  };
  const operations = compileOperations([], [
    { namespace: 'observation', operations: { inspect: definition } },
  ]);
  const execution = compileActionExecution(
    {
      action: definition.id,
      contract_version: 1,
      config: { private: 'PRIVATE-OBSERVATION-CONFIG' },
      inputs: Object.fromEntries(
        Object.entries(observationInputs).map(([name, literal]) => [name, { literal }]),
      ),
    },
    operations,
    'node',
  );
  const processes = createTestProcessRunner(root);
  try {
    const inputs = resolveExecutionInputs(execution.operation.inputs, execution.inputs, {}, {}, {
      card_id: 'project', card_type: 'project', card_title: 'Observation fixture',
    });
    const invocation = await invokeOperation({
      projectRoot: root,
      cardId: 'project',
      execution,
      inputs,
      binding: { kind: 'node', activation_id: randomUUID(), node_id: 'named-observations', ordinal: 0 },
      processRunner: processes.processRunner,
      runtimeProcessRootScope: processes.runtimeProcessRootScope,
      signal: new AbortController().signal,
      retainSettlementFailure(error) { throw error; },
    });
    const selected = selectOperationRoute(execution, [
      { outcome: 'observed', routeId: 'original-secret-value', test: { field: 'api_token', op: 'eq', value: observationOutputs.api_token } },
      { outcome: 'observed', routeId: 'incorrectly-neutralized', test: null },
    ], invocation.result);
    return {
      invocation: { invocationId: invocation.invocationId, result: invocation.result },
      received,
      selected,
    };
  } finally {
    await cleanupTestProcessRunners(root);
  }
}
