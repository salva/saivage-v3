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
import { tmpdir } from 'node:os';
import {
  appendCardExecutions,
  readCardExecutions,
  inspectCardExecutions,
  type CardExecutionStart,
  type CardExecutionFinish,
} from '../../src/persistence/card-execution-log.js';
import { cardExecutionFile } from '../../src/persistence/layout.js';
import { sha256Hex } from '../../src/schemas/sha256.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-executions-'));
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
    output_source: null,
    artifact_paths: [],
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
    output: null,
    absent_artifacts: [],
    external_effects: 'unknown',
  };
}
describe('lazy exact card execution evidence', () => {
  it('pure inspection reports a torn suffix without truncation and keeps strict association validation', () => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    expect(inspectCardExecutions(root, 'project').projection).toEqual([]);
    expect(existsSync(path)).toBe(false);
    const row = start();
    appendCardExecutions(root, 'project', [row]);
    const prefix = readFileSync(path);
    appendFileSync(path, Buffer.from([0xe2, 0x82]));
    const torn = readFileSync(path);
    expect(inspectCardExecutions(root, 'project')).toMatchObject({
      projection: [row], retainedLength: prefix.length, tornSuffixLength: 2,
    });
    expect(readFileSync(path)).toEqual(torn);
    const invalid = Buffer.from(`${JSON.stringify({ version: 3, type: 'card-execution', rows: [finish(start())] })}\npartial`);
    writeFileSync(path, invalid);
    expect(() => inspectCardExecutions(root, 'project')).toThrow(/open invocation/);
    expect(readFileSync(path)).toEqual(invalid);
  });
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
      [3, 'card-execution', 1],
      [3, 'card-execution', 2],
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
      `${JSON.stringify({ version: 3, type: 'card-execution', rows: [row] })}\npartial`,
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
  it('rejects output without a matching declaration and undeclared artifact observations', () => {
    const root = project();
    const s = start();
    const f = finish(s);
    appendCardExecutions(root, 'project', [s]);
    const before = readFileSync(cardExecutionFile(root, 'project'));
    expect(() => appendCardExecutions(root, 'project', [{ ...f, output: {
      source: 'returned-text', size_bytes: 6, sha256: sha256Hex('report'),
    } }])).toThrow(/source declaration/);
    expect(() => appendCardExecutions(root, 'project', [{ ...f, absent_artifacts: ['undeclared.txt'] }]))
      .toThrow(/declared selection/);
    expect(readFileSync(cardExecutionFile(root, 'project'))).toEqual(before);
    appendCardExecutions(root, 'project', [f]);
  });
  it('retains returned-text descriptors without inventing a process, and refuses fake stdout', () => {
    const root = project();
    const s = { ...start(), output_source: 'returned-text' as const };
    const f = { ...finish(s), output: { source: 'returned-text' as const, size_bytes: 6, sha256: sha256Hex('report') } };
    appendCardExecutions(root, 'project', [s, f]);
    expect(readCardExecutions(root, 'project').at(-1)).toMatchObject({ process: null, output: f.output });
    const stdout = { ...start(), output_source: 'command-stdout' as const };
    appendCardExecutions(root, 'project', [stdout]);
    expect(() => appendCardExecutions(root, 'project', [{ ...finish(stdout), output: {
      ...f.output, source: 'command-stdout',
    } }])).toThrow(/complete captured process facts/);
  });
  it('rejects native association, parent and exact selection mismatches without publication', () => {
    const root = project(), invocation = randomUUID();
    const native = { kind: 'native_started' as const, row_id: randomUUID(), invocation_id: invocation,
      card_id: 'project', timestamp: new Date().toISOString(), step: 'captureRebase' as const,
      binding: { origin: 'activation' as const, activation_id: randomUUID(), parent_card_id: null, node: null },
      artifact_paths: [`.saivage/work/cards/project/tmp/native-git-${invocation}/index`] };
    expect(() => appendCardExecutions(root, 'project', [{ ...native, binding: { ...native.binding, parent_card_id: 'card-a' } }])).toThrow(/parent/);
    expect(() => appendCardExecutions(root, 'project', [{ ...native, artifact_paths: ['wrong/index'] }])).toThrow(/index selection/);
    appendCardExecutions(root, 'project', [native]);
    const bytes = readFileSync(cardExecutionFile(root, 'project'));
    expect(() => appendCardExecutions(root, 'project', [{ ...finish(start()), invocation_id: invocation }])).toThrow(/family/);
    expect(() => appendCardExecutions(root, 'project', [{ kind: 'native_process_started', row_id: randomUUID(),
      invocation_id: invocation, card_id: 'project', timestamp: native.timestamp, process_id: 'proc-0123456789ab', allowed_exit_codes: [0],
      files: [{ kind: 'capture', stream: 'stdout', path: 'foreign/stdout.log' },
        { kind: 'capture', stream: 'stderr', path: 'foreign/stderr.log' }] }])).toThrow(/exact process/);
    expect(readFileSync(cardExecutionFile(root, 'project'))).toEqual(bytes);
  });

  it.each([
    { step: 'commission', binding: { activation_id: randomUUID(), parent_card_id: null, node: null } },
    { step: 'commission', binding: { origin: 'bootstrap', activation_id: randomUUID() } },
    { step: 'commission', binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null, node: null } },
    { step: 'checkpoint', binding: { origin: 'bootstrap' } },
  ])('strictly rejects missing/mixed/inapplicable native origin %#', ({ step, binding }) => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    const bytes = `${JSON.stringify({ version: 3, type: 'card-execution', rows: [{
      kind: 'native_started', row_id: randomUUID(), invocation_id: randomUUID(), card_id: 'project',
      timestamp: new Date().toISOString(), step, binding, artifact_paths: [],
    }] })}\n`;
    writeFileSync(path, bytes);
    expect(() => readCardExecutions(root, 'project')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('rejects bootstrap native evidence for a non-root card before publication', () => {
    const root = project();
    expect(() => appendCardExecutions(root, 'card-a', [{ kind: 'native_started',
      row_id: randomUUID(), invocation_id: randomUUID(), card_id: 'card-a',
      timestamp: new Date().toISOString(), step: 'commission', binding: { origin: 'bootstrap' },
      artifact_paths: [],
    }])).toThrow(/root bootstrap/);
  });

  it('requires matched naturally finished sequential native commands, not exited-zero containment', () => {
    const root = project(), invocation_id = randomUUID();
    const identity = { invocation_id, card_id: 'project', timestamp: new Date().toISOString() };
    appendCardExecutions(root, 'project', [{ ...identity, row_id: randomUUID(), kind: 'native_started',
      step: 'checkpoint', artifact_paths: [], binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null, node: null } }]);
    const begin = (id: string) => ({ ...identity, row_id: randomUUID(), kind: 'native_process_started' as const,
      process_id: id, allowed_exit_codes: [0], files: (['stdout', 'stderr'] as const).map(stream => ({
        kind: 'capture' as const, stream, path: `.saivage/work/cards/project/processes/${id}/${stream}.log` })) });
    const first = begin('proc-0123456789ab'), next = begin('proc-0123456789ac');
    appendCardExecutions(root, 'project', [first]);
    expect(() => appendCardExecutions(root, 'project', [next])).toThrow(/unfinished/);
    const finished = { ...identity, row_id: randomUUID(), kind: 'native_process_finished' as const,
      process_id: first.process_id, disposition: 'returned' as const, status: 'exited' as const,
      leader_exit: { exit_code: 0, signal: null, observed_at: identity.timestamp }, leader_error: null,
      interruption: null, timeout_reason: null, process: { id: first.process_id, group: 'absent' as const,
        group_diagnostic: null, stdout: 'eof' as const, stderr: 'eof' as const, stdout_error: null, stderr_error: null } };
    expect(() => appendCardExecutions(root, 'project', [{ ...finished, status: 'killed' }])).toThrow(/natural/);
    appendCardExecutions(root, 'project', [finished, next]);
    expect(readCardExecutions(root, 'project')).toHaveLength(4);
    expect(() => appendCardExecutions(root, 'project', [{ ...finished, row_id: randomUUID() }])).toThrow(/matching/);
  });

  it.each([0, 1, 2, 4, 'rows'])('rejects complete unsupported envelopes without rewriting %#', (bad) => {
    const root = project();
    const path = cardExecutionFile(root, 'project');
    const bytes = Buffer.from(
      `${JSON.stringify({ version: typeof bad === 'number' ? bad : 3, type: typeof bad === 'string' ? bad : 'card-execution', rows: [start()] })}\n`,
    );
    writeFileSync(path, bytes);
    expect(() => readCardExecutions(root, 'project')).toThrow();
    expect(readFileSync(path)).toEqual(bytes);
  });
});
