import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  compileOperations,
  validateOperationReturn,
  validateOperationValues,
  type OperationDefinition,
} from '../../../src/runtime/card-process/operation-contract.js';
import {
  shellOperationConfigSchema,
  shellRunOperation,
} from '../../../src/runtime/card-process/shell-operation.js';

const inspect: OperationDefinition = {
  id: 'acme-analysis.inspect',
  provider: { kind: 'plugin', name: 'acme-analysis' },
  contractVersion: 1,
  bindings: ['node'],
  config: z.object({}).strict(),
  inputs: { scope: { type: 'string', enum: ['changed-files', 'project'], workflow: true } },
  outcomes: {
    finished: {
      status: { type: 'string', enum: ['complete', 'partial'], workflow: true },
      count: { type: 'integer', min: 0, max: 1000, workflow: true },
      paths: { type: 'strings', workflow: false },
    },
  },
  retainFields: ['status', 'count'],
  async run(_config, input) {
    return {
      outcome: 'finished',
      summary: `Inspected ${input.scope}`,
      values: { status: 'complete', count: 2, paths: ['a.ts', 'b.ts'] },
    };
  },
};

describe('explicit compiled operation contracts', () => {
  it('declares four distinct shell outcomes and keeps script/argv literal through the concrete capability', async () => {
    const operations = compileOperations([shellRunOperation]);
    const definition = operations.get('shell.run')!;
    expect(Object.keys(definition.outcomes)).toEqual([
      'passed',
      'failed',
      'signalled',
      'timed_out',
    ]);
    const config = shellOperationConfigSchema.parse({ script: 'printf "%s" "$@"; echo "${NAME}"' });
    let selected: unknown;
    const returned = await definition.run(
      config,
      { args: ['$(not-code)', 'a b'] },
      {
        command: async (input) => {
          selected = input;
          return { outcome: 'passed', summary: 'Exited', values: { exit_code: 0 } };
        },
      },
      new AbortController().signal,
    );
    expect(selected).toEqual({
      script: config.script,
      args: ['$(not-code)', 'a b'],
      cwd: '.',
      env: {},
      timeoutMs: 120000,
      terminateGraceMs: 2000,
    });
    expect(validateOperationReturn(definition, returned).values).toEqual({ exit_code: 0 });
    expect(() =>
      validateOperationReturn(definition, {
        outcome: 'signalled',
        summary: 'Signal',
        values: { exit_code: 143 },
      }),
    ).toThrow();
  });
  it('rejects shell escaping cwd, secret/root env and artifact globs instead of normalizing them', () => {
    for (const change of [
      { cwd: '/outside' },
      { cwd: '../outside' },
      { env: { API_TOKEN: 'private' } },
      { env: { SAIVAGE_ROOT: 'other' } },
      { artifacts: ['reports/*.txt'] },
    ])
      expect(() => shellOperationConfigSchema.parse({ script: 'true', ...change })).toThrow();
  });
  it('keeps plugin values independent of a core output union and freezes the compiled declaration', async () => {
    const operations = compileOperations(
      [],
      [{ namespace: 'acme-analysis', operations: { inspect } }],
    );
    const definition = operations.get('acme-analysis.inspect')!;
    const input = validateOperationValues(definition.inputs, { scope: 'project' });
    const result = validateOperationReturn(
      definition,
      await definition.run({}, input, {}, new AbortController().signal),
    );
    expect(result).toEqual({
      outcome: 'finished',
      summary: 'Inspected project',
      values: { status: 'complete', count: 2, paths: ['a.ts', 'b.ts'] },
    });
    expect(Object.isFrozen(definition.outcomes.finished)).toBe(true);
    expect('set' in operations).toBe(false);
    expect(operations.get('inspect')).toBeUndefined();
  });
  it('rejects reserved/duplicate namespaces, mismatched qualified IDs and duplicate builtins before map construction', () => {
    const plugin = { namespace: 'acme-analysis', operations: { inspect } };
    expect(() => compileOperations([], [plugin, plugin])).toThrow(/duplicate.*namespace/);
    expect(() => compileOperations([], [{ ...plugin, namespace: 'shell' }])).toThrow(/Reserved/);
    expect(() => compileOperations([], [{ ...plugin, operations: { other: inspect } }])).toThrow(
      /identity/,
    );
    const builtin = {
      ...inspect,
      id: 'shell.run',
      provider: { kind: 'builtin' as const, name: 'shell' },
    };
    expect(() => compileOperations([builtin, builtin])).toThrow(/Duplicate operation/);
  });
  it.each([
    { status: 'complete', count: 1 },
    { status: 'complete', count: -1, paths: [] },
    { status: 'complete', count: '1', paths: [] },
    { status: 'complete', count: 1, paths: [], extra: true },
    { status: 'unknown', count: 1, paths: [] },
    { status: 'complete', count: 1, paths: ['x'.repeat(4097)] },
  ])('rejects invalid effect returns without coercion %#', (values) => {
    expect(() =>
      validateOperationReturn(inspect, { outcome: 'finished', summary: 'Observed', values }),
    ).toThrow();
  });
  it('rejects undeclared outcomes, private retention and aggregate oversized values', () => {
    expect(() =>
      validateOperationReturn(inspect, { outcome: 'other', summary: 'Observed', values: {} }),
    ).toThrow(/undeclared/);
    expect(() =>
      compileOperations(
        [],
        [
          {
            namespace: 'acme-analysis',
            operations: { inspect: { ...inspect, retainFields: ['paths'] } },
          },
        ],
      ),
    ).toThrow(/workflow-safe/);
    expect(() =>
      validateOperationValues(
        { paths: { type: 'strings', workflow: true } },
        { paths: Array.from({ length: 20 }, () => 'x'.repeat(4096)) },
      ),
    ).toThrow(/64KiB/);
  });
});
