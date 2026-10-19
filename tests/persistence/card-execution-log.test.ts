import { afterEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  appendCardExecutions,
  readCardExecutions,
  type CardExecutionStart,
  type CardExecutionFinish,
} from '../../src/persistence/card-execution-log.js';
import { cardExecutionFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = mkdtempSync('/home/salva/g/ml/tmp/saivage-executions-');
  roots.push(root);
  mkdirSync(dirname(cardExecutionFile(root, 'project')), { recursive: true });
  return root;
}
function start(): CardExecutionStart {
  return {
    kind: 'invocation_started',
    row_id: randomUUID(),
    invocation_id: randomUUID(),
    card_id: 'project',
    timestamp: '2026-10-19T00:00:00.000Z',
    operation: 'acme-analysis.inspect',
    contract_version: 1,
    provider: { kind: 'plugin', name: 'acme-analysis' },
    binding: { kind: 'node', activation_id: randomUUID(), node_id: 'inspect', ordinal: 0 },
    input: [],
    config: [],
    shell: null,
  };
}
function finish(source: CardExecutionStart): CardExecutionFinish {
  return {
    kind: 'invocation_finished',
    row_id: randomUUID(),
    invocation_id: source.invocation_id,
    card_id: 'project',
    timestamp: source.timestamp,
    disposition: 'returned',
    summary: 'Observed',
    leader_exit: null,
    leader_error: null,
    interruption: null,
    timeout_reason: null,
    process: null,
    outcome: 'finished',
    values: [{ name: 'count', type: 'integer', value: 2 }],
    files: [],
    absent_artifacts: [],
    external_effects: 'unknown',
  };
}
describe('lazy exact card execution evidence', () => {
  it('preserves incomplete invocations and ordered envelopes without inventing a closing', () => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    expect(readCardExecutions(root, 'project')).toEqual([]);
    expect(existsSync(path)).toBe(false);
    const first = start();
    const second = start();
    appendCardExecutions(root, 'project', [first]);
    appendCardExecutions(root, 'project', [second, finish(second)]);
    expect(readCardExecutions(root, 'project')).toHaveLength(3);
    const envelopes = readFileSync(path, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(envelopes.map(({ version, type, rows }) => [version, type, rows.length])).toEqual([
      [1, 'card-execution', 1],
      [1, 'card-execution', 2],
    ]);
  });
  it('validates the complete retained prefix before truncating only the torn final suffix', () => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    const row = start();
    appendCardExecutions(root, 'project', [row]);
    const prefix = readFileSync(path);
    appendFileSync(path, Buffer.from([0xe2, 0x82]));
    expect(readCardExecutions(root, 'project')).toEqual([row]);
    expect(readFileSync(path)).toEqual(prefix);
    appendFileSync(
      path,
      `${JSON.stringify({ version: 1, type: 'card-execution', rows: [row] })}\npartial`,
    );
    const invalid = readFileSync(path);
    expect(() => readCardExecutions(root, 'project')).toThrow(/duplicate|Duplicate/);
    expect(() => appendCardExecutions(root, 'project', [start()])).toThrow();
    expect(readFileSync(path)).toEqual(invalid);
  });
  it('rejects duplicate completion, mismatched owner and completion without entry before appending', () => {
    const root = project();
    const first = start();
    const closing = finish(first);
    appendCardExecutions(root, 'project', [first, closing]);
    const path = cardExecutionFile(root, 'project');
    const bytes = readFileSync(path);
    expect(() =>
      appendCardExecutions(root, 'project', [{ ...closing, row_id: randomUUID() }]),
    ).toThrow(/open invocation/);
    expect(() =>
      appendCardExecutions(root, 'project', [{ ...start(), card_id: 'card-a' }]),
    ).toThrow(/identity/);
    expect(() => appendCardExecutions(root, 'project', [finish(start())])).toThrow(
      /open invocation/,
    );
    expect(readFileSync(path)).toEqual(bytes);
  });
  it.each([0, 2, 'rows'])('rejects complete unsupported envelopes without rewriting %#', (bad) => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    const bytes = Buffer.from(
      `${JSON.stringify({ version: typeof bad === 'number' ? bad : 1, type: typeof bad === 'string' ? bad : 'card-execution', rows: [start()] })}\n`,
    );
    writeFileSync(path, bytes);
    expect(() => readCardExecutions(root, 'project')).toThrow();
    expect(readFileSync(path)).toEqual(bytes);
  });
});
