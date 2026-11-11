import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import type { CardExecutionStart } from '../../src/persistence/card-execution-log.js';
import { agentMessageSchema, type RecordDefinition } from '../../src/schemas/index.js';
import { cardConversationVersionFile, cardConversationVersionIndexFile, cardExecutionFile, cardRecordsRoot, cardRecordHeadFile } from '../../src/persistence/layout.js';
import type { WorkGcCollectionContext } from '../../src/workspace/work-garbage-collector.js';
import { WebfetchTextDataSchema } from '../../src/contracts/webfetch.js';
import { publicNativeProject, publicNativeCli, nativeOptions, fixtureGit } from '../helpers/public-native-project.js';

// Jest's VM-module named builtin exports do not follow syncBuiltinESMExports. Forward only
// this test module's collector imports to the real builtin object, where faults are installed.
jest.unstable_mockModule('node:fs', () => ({ ...fs, default: fs,
  readFileSync: (...args: Parameters<typeof fs.readFileSync>) => fs.readFileSync(...args),
  realpathSync: (...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args),
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => fs.lstatSync(...args),
  openSync: (...args: Parameters<typeof fs.openSync>) => fs.openSync(...args),
  opendirSync: (...args: Parameters<typeof fs.opendirSync>) => fs.opendirSync(...args),
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => fs.unlinkSync(...args),
  closeSync: (...args: Parameters<typeof fs.closeSync>) => fs.closeSync(...args),
  fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => fs.fsyncSync(...args),
}));
const { initProjectTree, CardService, TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
const { genericRecordDefinition } = await import('../../src/schemas/index.js');
const { initializeRecordBaseline } = await import('../../src/persistence/authored-record-files.js');
const { appendConversationBatch, publishCompactedConversationSegment, readCurrentConversationSegment } = await import('../../src/persistence/conversation-file.js');
const { versionFilename } = await import('../../src/persistence/canonical-conversation-artifacts.js');
const { appendCardExecutions } = await import('../../src/persistence/card-execution-log.js');
const { collectWorkGarbage, inventoryWorkGarbage } = await import('../../src/workspace/work-garbage-collector.js');
const { OPERATIONAL_RESULT_POLICY_TEMPLATE } = await import('../../src/tools/invocation.js');
const { toolRowPolicies } = await import('../helpers/row-policy-fixtures.js');
const { composeContextProjection, providerConversationFromComposedContext } = await import('../../src/runtime/actors/context/composition-projector.js');
const { inspectWorkGcCanonicalState } = await import('../../src/persistence/current-generated-graph.js');
const { cardAgentSessionId } = await import('../../src/schemas/index.js');

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'work-gc-test-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}
function work(root: string, name: string, content = 'abcd', time = 1000): string {
  const path = join(root, '.saivage/work', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, time / 1000, time / 1000);
  return path;
}
function definition(filename = 'review-extra.md'): RecordDefinition {
  const record = genericRecordDefinition(filename);
  return { filename, format: record.format, schema: record.schema, bootstrap: false, declared: false };
}
function baseline(root: string, content: string): void {
  initializeRecordBaseline(root, new CardService(root).read('project')!, definition(), () => content);
}
function context(overrides: Partial<WorkGcCollectionContext> = {}): WorkGcCollectionContext {
  return { workflows: TEST_WORKFLOWS, operationalInputs: {}, protection: { retainAll: false, capturePaths: [] },
    assertCollecting: () => {}, fatal: error => { throw error; }, ...overrides };
}
const inventory = (root: string) => inventoryWorkGarbage(root, new AbortController().signal);
function message(content: string): ReturnType<typeof agentMessageSchema.parse> {
  return agentMessageSchema.parse({ id: randomUUID(), session_id: 'agent:planner:project', role: 'user',
    kind: 'text', content, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' },
      audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
    round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-10-24T00:00:00.000Z' });
}

async function canonicalBytes(root: string): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>(), read = fs.readFileSync;
  const prefixes = ['cards', 'agents', 'logs'].map(name => join(root, '.saivage', name) + '/');
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
    const value = (read as any)(path, ...args);
    if (prefixes.some(prefix => String(path).startsWith(prefix))) bytes.set(String(path), Buffer.from(value));
    return value;
  }) as typeof read);
  try {
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, { content: async () => {}, operational: async () => {} });
  } finally { spy.mockRestore(); }
  expect(bytes.size).toBeGreaterThan(0);
  return bytes;
}

function toolExchange(tool: string, content: string, argumentsText = '{}') {
  const policy = toolRowPolicies({ content, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
  const inputId = randomUUID(), callId = 'current-call';
  return [
    agentMessageSchema.parse({ ...message(''), id: `${inputId}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call',
      tool, tool_call_id: callId, context_policy: policy.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: argumentsText } }] }) }),
    agentMessageSchema.parse({ ...message(content), id: `${inputId}:tool-result:${callId}`, role: 'tool', kind: 'tool_result',
      tool, tool_call_id: callId, context_policy: policy.result }),
  ];
}

describe('work GC two-phase selection', () => {
  it.each(['unreferenced', 'purpose', 'shell', 'card', 'sibling'] as const)(
    'keeps ordinary shell and sibling work semantics for a current %s reference', async reference => {
      const root = fixture();
      const paths = [
        'cards/project/shell/install-check/result.txt',
        'cards/project/shell/other/result.txt',
        'cards/project/ordinary-sibling/result.txt',
        'cards/project/tmp/other.txt',
        'cards/project/processes/proc-other/stdout.log',
      ].map(name => work(root, name));
      const references = {
        unreferenced: [],
        purpose: ['work:///cards/project/shell/install-check'],
        shell: ['work:///cards/project/shell'],
        card: ['work:///cards/project'],
        sibling: ['work:///cards/project/ordinary-sibling'],
      };
      baseline(root, JSON.stringify({ paths: references[reference] }));
      const protectedIndexes = reference === 'purpose' ? [0] : reference === 'shell' ? [0, 1]
        : reference === 'sibling' ? [2] : [];
      const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
      expect(preview).toMatchObject({ observed_count: 5, would_delete_count: 5 - protectedIndexes.length,
        deleted_count: 0, retained: { protected: protectedIndexes.length } });
      expect(paths.every(existsSync)).toBe(true);
      const deleted = await collectWorkGarbage(await inventory(root), { mode: 'delete', before: 2000 }, context());
      expect(deleted.deleted_count).toBe(preview.would_delete_count);
      for (const [index, path] of paths.entries()) {
        expect(existsSync(path)).toBe(protectedIndexes.includes(index));
        if (protectedIndexes.includes(index)) expect(readFileSync(path, 'utf8')).toBe('abcd');
        expect(existsSync(dirname(path))).toBe(true);
      }
    });

  it('previews and deletes work beneath content administrative roots while preserving concrete artifacts and canonical bytes', async () => {
    const root = fixture(), w = join(root, '.saivage/work'), c = join(w, 'cards/project');
    const selected = [
      'cards/project/foo/inside', 'cards/project/tmp/foo/inside',
      'cards/project/processes/proc-selected/stdout.log', 'processes/proc-selected/stderr.log',
      'tmp/stash/selected/inside', 'cards/project/tmp/exact.txt',
    ].map(name => work(root, name));
    const garbage = [
      'cards/project/foobar/outside', 'cards/project/tmp/foobar/outside',
      'cards/project/processes/proc-other/stdout.log', 'processes/proc-other/stderr.log',
      'tmp/stash/other/inside', 'cards/project/tmp/unreferenced',
    ].map(name => work(root, name));
    const recent = work(root, 'cards/project/tmp/recent', 'recent', 3000);
    const administrative = [root, dirname(root), '/', join(root, '.saivage'), w,
      join(w, 'cards'), c, join(c, 'tmp'), join(c, 'processes'),
      join(w, 'processes'), join(w, 'tmp'), join(w, 'tmp/stash')];
    new CardService(root).acceptRecord('project', 'status.md', [
      `The project is in ${root}.`,
      ...administrative.map(path => JSON.stringify({ source_path: path })),
      JSON.stringify({ paths: [join(c, 'foo'), join(c, 'tmp/foo'),
        join(c, 'processes/proc-selected'), join(w, 'processes/proc-selected'),
        join(w, 'tmp/stash/selected'), selected[5]] }),
    ].join('\n'), { kind: 'agent', agent: 'analyst' });
    const before = await canonicalBytes(root);
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(preview).toMatchObject({ observed_count: 13, would_delete_count: 6, deleted_count: 0,
      retained: { protected: 6, recent: 1 } });
    expect([...selected, ...garbage, recent].every(existsSync)).toBe(true);
    expect(await canonicalBytes(root)).toEqual(before);
    const deleted = await collectWorkGarbage(await inventory(root), { mode: 'delete', before: 2000 }, context());
    expect(deleted.deleted_count).toBe(preview.would_delete_count);
    expect(garbage.every(path => !existsSync(path))).toBe(true);
    expect([...selected, recent].every(existsSync)).toBe(true);
    expect(garbage.map(dirname).every(existsSync)).toBe(true);
    expect(await canonicalBytes(root)).toEqual(before);
  });

  it.each(['prose', 'structured'] as const)('normalizes administrative roots and concrete references equally in %s, including known aliases and missing suffixes', async origin => {
    const root = fixture(), w = join(root, '.saivage/work');
    const selected = work(root, 'cards/project/tmp/selected space/inside');
    const garbage = work(root, 'cards/project/tmp/control');
    symlinkSync(w, join(root, 'work-alias'));
    symlinkSync(join(w, 'cards/project/tmp/selected space'), join(root, 'concrete-alias'));
    symlinkSync(root, join(root, 'project-alias'));
    const references = [
      `${root}/`, `${root}/.saivage/..`, dirname(root), '/',
      '.saivage/', '.saivage/work/cards/project/tmp/../',
      'project:///', 'project:///.saivage/work/', 'system:///',
      `system:///${w.slice(1)}/cards/./project/tmp/`, 'work:///',
      'work:///cards', 'work:///cards/project', 'tmp:///project/',
      'work:///cards/project/processes', 'work:///processes/', 'work:///tmp/stash/../stash/',
      `file://${w}/tmp/stash/`, 'project:///work-alias', 'project:///project-alias',
      'project:///work-alias/cards/project/tmp/absent/../',
      'project:///concrete-alias', 'project:///concrete-alias/missing-suffix',
      'work:///cards/project/tmp/selected%20space',
      '.saivage/work/cards/project/tmp/selected space/./',
    ];
    baseline(root, origin === 'structured' ? JSON.stringify({ paths: references })
      : references.map(path => `Keep \`${path}\``).join('\n'));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result).toMatchObject({ deleted_count: 1, retained: { protected: 1 } });
    expect(existsSync(selected)).toBe(true); expect(existsSync(garbage)).toBe(false);
  });

  it('does not broaden concrete alias missing suffixes, case-distinct names or sibling prefixes', async () => {
    const root = fixture(), w = join(root, '.saivage/work');
    const selected = work(root, 'cards/project/foo/inside');
    const garbage = ['cards/project/foobar/inside', 'cards/project/tmp/case/inside',
      'cards/project/tmp/alias-parent/other'].map(name => work(root, name));
    symlinkSync(join(w, 'cards/project/tmp/alias-parent'), join(root, 'alias'));
    symlinkSync(`${w}-sibling`, join(root, 'unrelated-alias'));
    mkdirSync(`${w}-sibling`);
    baseline(root, JSON.stringify({ paths: [
      'work:///cards/project/foo', 'work:///cards/project/tmp/Case',
      'work:///cards/projectish', 'project:///alias/missing/file', 'project:///unrelated-alias',
      `${w}-sibling`, 'work:///cards/card-n', 'work:///cards/card-na/tmp',
    ] }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result).toMatchObject({ deleted_count: 3, retained: { protected: 1 } });
    expect(existsSync(selected)).toBe(true); expect(garbage.every(path => !existsSync(path))).toBe(true);
  });

  it.each(['work:///%ZZ', 'tmp:///not-a-card/', 'work:///cards/project/tmp?unknown'])('retains unknown scope for malformed recognized content URI %s', async reference => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    baseline(root, JSON.stringify({ path: reference }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result).toMatchObject({ deleted_count: 0, retained: { protected: 1 } });
    expect(existsSync(candidate)).toBe(true);
  });

  it('still resolves administrative lexical content paths to concrete targets or unknown scope', async () => {
    const root = fixture(), w = join(root, '.saivage/work');
    const selected = work(root, 'cards/project/foo/inside'), garbage = work(root, 'tmp/stash/control');
    baseline(root, JSON.stringify({ path: w }));
    const realpath = fs.realpathSync;
    const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) =>
      String(path) === w ? join(w, 'cards/project/foo') : (realpath as any)(path, ...args)) as typeof realpath);
    expect((await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context())).would_delete_count).toBe(1);
    spy.mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === w) throw Object.assign(new Error('unknown scope'), { code: 'EACCES' });
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    expect((await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context())).deleted_count).toBe(0);
    expect([selected, garbage].every(existsSync)).toBe(true);
  });

  it.each(['retainAll', 'capture parent', 'operational inputs', 'unfinished artifact', 'unfinished file', 'configured prompt', 'workflow inputs'] as const)(
    'preserves operational administrative-root protection: %s', async source => {
      const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
      baseline(root, `Project ${root}; work:///cards/project/tmp`);
      const overrides: { -readonly [K in keyof WorkGcCollectionContext]?: WorkGcCollectionContext[K] } = {};
      if (source === 'retainAll') overrides.protection = { retainAll: true, capturePaths: [] };
      if (source === 'capture parent') overrides.protection = { retainAll: false, capturePaths: [join(root, 'stdout.log')] };
      if (source === 'operational inputs') overrides.operationalInputs = { root };
      if (source === 'configured prompt') overrides.workflows = { ...TEST_WORKFLOWS,
        analystPrompt: { ...TEST_WORKFLOWS.analystPrompt, path: root } };
      if (source === 'workflow inputs') {
        const workflow = TEST_WORKFLOWS.cardTypes.get('project')!;
        const states = new Map([...workflow.states].map(([key, state]) => [key,
          state.kind !== 'node' || state.execution.kind !== 'agent' ? state
            : { ...state, execution: { ...state.execution, inputs: { source_path: { literal: root } } } },
        ] as const));
        overrides.workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes).set('project', { ...workflow, states }) };
      }
      if (source === 'unfinished artifact' || source === 'unfinished file') {
        const start: CardExecutionStart = { kind: 'invocation_started', row_id: randomUUID(), invocation_id: randomUUID(),
          card_id: 'project', timestamp: '2026-10-24T00:00:00.000Z', operation: 'shell.run', contract_version: 1,
          provider: { kind: 'builtin', name: 'shell' }, binding: { kind: 'node', activation_id: randomUUID(), node_id: 'run', ordinal: 0 },
          output_source: 'command-stdout', artifact_paths: source === 'unfinished artifact' ? ['.saivage/work'] : [],
          input: [], config: [], shell: { script: 'echo hello', cwd: '/unrelated', argv: [], env: {} } };
        appendCardExecutions(root, 'project', source === 'unfinished artifact' ? [start] : [start, {
          kind: 'process_started', row_id: randomUUID(), invocation_id: start.invocation_id, card_id: 'project',
          timestamp: start.timestamp, process_id: 'proc', files: [
            { kind: 'capture', stream: 'stdout', path: '.saivage/work' },
            { kind: 'capture', stream: 'stderr', path: '.saivage/work/cards' },
          ],
        }]);
      }
      const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context(overrides));
      expect(result).toMatchObject({ deleted_count: 0, retained: { protected: 1 } });
      expect(existsSync(candidate)).toBe(true);
      appendConversationBatch({ projectRoot: root }, [message('Strict canonical validation still applies.')]);
      const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
      const path = cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
      appendFileSync(path, '{malformed}\n');
      await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context(overrides))).rejects.toThrow();
      expect(existsSync(candidate)).toBe(true);
    });

  it.each([[8, 4, 1000], [32, 16, 4000]])('bounded scale: %i linked cards, %i segments/session, %i candidates', async (cardCount, segmentCount, candidates) => {
    const root = fixture(), cards = new CardService(root);
    const linked = [cards.read('project')!];
    for (let i = 1; i < cardCount!; i++) linked.push(cards.create({ type: 'code', parent: 'project',
      title: `bounded ${i}`, bootstrap_content: 'bounded brief', created_by: 'analyst', depends_on: [] }));
    const segmentPaths = new Set<string>();
    let sessions = 0;
    for (const card of linked) {
      const agents = new Set([...TEST_WORKFLOWS.cardTypes.get(card.type)!.states.values()].flatMap(state =>
        state.kind === 'node' && state.execution.kind === 'agent' && state.execution.agent.session === 'card' ? [state.execution.agent.name] : []));
      for (const agent of agents) {
        sessions++;
        const session = cardAgentSessionId(agent, card.id);
        for (let version = 1; version <= segmentCount!; version++) {
          const row = agentMessageSchema.parse({ ...message(`work:///cards/${card.id}/tmp/selected`), session_id: session });
          appendConversationBatch({ projectRoot: root }, [row]);
          const segment = readCurrentConversationSegment(root, session)!;
          segmentPaths.add(cardConversationVersionFile(root, card.id, agent, segment.entry.filename));
          if (version < segmentCount!) {
            const entryId = randomUUID();
            publishCompactedConversationSegment({ projectRoot: root }, session, {
              identity: { genesisId: randomUUID(), entryId, segmentVersion: version + 1,
                timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(version + 1, entryId) },
              history: { summaryText: 'bounded summary', protectedPrompts: [],
                requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
              cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
            });
          }
        }
      }
      work(root, `cards/${card.id}/tmp/selected`);
    }
    for (let i = cardCount!; i < candidates!; i++) work(root, `cards/project/tmp/control-${i}`);
    const started = performance.now(), found = await inventory(root), inventoried = performance.now();
    const read = fs.readFileSync, has = Set.prototype.has;
    let segmentReads = 0, membership = 0, visits = 0;
    jest.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
      if (segmentPaths.has(String(path))) segmentReads++;
      return (read as any)(path, ...args);
    }) as typeof read);
    jest.spyOn(Set.prototype, 'has').mockImplementation(function(this: Set<unknown>, value: unknown) {
      if (typeof value === 'string' && value.startsWith(join(root, '.saivage/work'))) membership++;
      return has.call(this, value);
    });
    const result = await collectWorkGarbage(found, { mode: 'dry_run' }, context({ assertCollecting: () => { visits++; } }));
    expect(found.candidates).toHaveLength(candidates!);
    expect(segmentReads).toBe(sessions * segmentCount!);
    expect(result.retained.protected).toBe(cardCount!);
    expect(result.would_delete_count).toBe(candidates! - cardCount!);
    expect(membership).toBeLessThanOrEqual(candidates! * 6);
    // A fixed per-source/per-candidate bound, not segment-history × candidate work.
    expect(visits).toBeLessThan(sessions * segmentCount! * 150 + candidates! * 3 + 5000);
    console.info('GC bounded evidence', JSON.stringify({ cardCount, segmentCount, sessions, candidates,
      segmentReads, extractionAndBoundaryChecks: visits, ancestorMembership: membership,
      inventoryMs: inventoried - started, markingAndSelectionMs: performance.now() - inventoried, heapBytes: process.memoryUsage().heapUsed }));
  }, 60_000);

  it('marks current semantic content without marking index, genesis or whole row envelopes', async () => {
    const root = fixture();
    const cwd = join(root, '.saivage/work/cards/project/tmp/context');
    const selected = ['relative-name', 'quoted space.txt', 'query.txt'].map(name => work(root, `cards/project/tmp/context/${name}`));
    work(root, 'cards/project/tmp/contextish/not-selected');
    const row = message(JSON.stringify({ cwd, inputs: [{ name: 'source_path', value: { literal: 'relative-name' } }],
      prose: '`quoted space.txt`', nested: JSON.stringify({ endpoint: `https://example.invalid/?path=${encodeURIComponent('tmp:///project/context/query.txt')}` }) }));
    appendConversationBatch({ projectRoot: root }, [row]);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const read = fs.realpathSync;
    let observed = new Set<string>(), resolutions = 0;
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      observed.add(String(path)); resolutions++;
      return (read as any)(path, ...args);
    }) as typeof read);
    const found = await inventory(root);
    const old = await collectWorkGarbage(found, { mode: 'dry_run' }, context({ operationalInputs: segment }));
    const oldUnion = observed, oldResolutions = resolutions;
    observed = new Set(); resolutions = 0;
    const current = await collectWorkGarbage(found, { mode: 'dry_run' }, context({ operationalInputs: [segment.index, segment.genesis, segment.rows] }));
    expect(current).toEqual(old);
    expect(observed).toEqual(oldUnion);
    expect(resolutions).toBeLessThan(oldResolutions);
    expect(current.retained.protected).toBe(selected.length);
    const sources: unknown[] = [];
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, { content: async value => { sources.push(value); }, operational: async () => {} });
    expect(sources).toContain(row.content);
    expect(sources).not.toContainEqual(segment.index);
    expect(sources).not.toContainEqual(segment.genesis);
    expect(sources).not.toContainEqual(segment.rows);
    expect(sources).not.toContainEqual(segment);
    console.info('GC union evidence', JSON.stringify({ oldResolutions, sourceResolutions: resolutions, unionSize: observed.size }));
  });

  it.each(['nested values', 'text tokens'])('observes real event-loop cancellation during inventory and %s before effects', async kind => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/untouched');
    const controller = new AbortController();
    const task = inventoryWorkGarbage(root, controller.signal);
    await setImmediate(); controller.abort(new Error('inventory cancellation'));
    await expect(task).rejects.toThrow('inventory cancellation');
    const found = await inventory(root);
    const marking = new AbortController();
    let entered = false, checks = 0;
    let nested: unknown = 'not a path';
    for (let i = 0; i < 512; i++) nested = { values: [nested] };
    const operationalInputs = { get nested() {
      entered = true;
      return kind === 'nested values' ? nested : 'tmp:///project/untouched '.repeat(2000);
    } };
    const collecting = collectWorkGarbage(found, { mode: 'delete' }, context({ operationalInputs,
      assertCollecting: () => {
        checks++; marking.signal.throwIfAborted();
        if (entered && !marking.signal.aborted) {
          entered = false;
          void setImmediate().then(() => marking.abort(new Error('nested cancellation')));
        }
      } }));
    await expect(collecting).rejects.toThrow('nested cancellation');
    expect(checks).toBeGreaterThan(256);
    await setImmediate();
    expect(existsSync(candidate)).toBe(true);
  });

  it('settles selection cancellation after a known deletion, without a later effect', async () => {
    const root = fixture(), a = work(root, 'cards/project/tmp/a'), b = work(root, 'cards/project/tmp/b');
    const controller = new AbortController(), unlink = fs.unlinkSync;
    jest.spyOn(fs, 'unlinkSync').mockImplementation(path => {
      unlink(path);
      void setImmediate().then(() => controller.abort(new Error('selection cancellation')));
    });
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({
      assertCollecting: () => controller.signal.throwIfAborted(),
    }))).rejects.toMatchObject({ name: 'WorkGcInterruptedError', result: { deleted_count: 1, deleted_logical_bytes: 4 } });
    await setImmediate();
    expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it.each(['record', 'conversation'])('selectively previews old work through 5120 characters of possessive %s prose', async source => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/selected.txt', 'selected bytes');
    const control = work(root, 'cards/project/tmp/control', 'control bytes');
    const span = ` resource/effect tmp:///project/selected.txt ${'ordinary guidance '.repeat(320)}`.slice(0, 5120);
    expect(span).toHaveLength(5120);
    const content = `The owner's${span}child's task uses \`guidance\` and isn't a pathname.`;
    if (source === 'record') baseline(root, content);
    else appendConversationBatch({ projectRoot: root }, [message(content)]);
    const bytes = [selected, control].map(path => readFileSync(path));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: 1 }, would_delete_count: 1, deleted_count: 0 });
    expect([selected, control].map(path => readFileSync(path))).toEqual(bytes);
  });

  it.each([
    ['plain LF', '\n', false], ['quoted LF', '\n', true],
    ['plain CRLF', '\r\n', false], ['quoted CRLF', '\r\n', true],
    ['plain CR', '\r', false], ['quoted CR', '\r', true],
  ] as const)('selectively previews current record-prompt Markdown (%s)', async (_label, newline, quoted) => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/selected.txt');
    const nested = work(root, 'cards/project/tmp/nested dir/with space.txt');
    const subtree = work(root, 'cards/project/tmp/evidence/inside');
    const control = work(root, 'cards/project/tmp/control');
    const recent = work(root, 'cards/project/tmp/recent', 'recent', 3000);
    const body = [
      '# Current status', '**Keep useful evidence**; ordinary guidance follows.',
      '[Selected evidence](tmp:///project/selected.txt)',
      `Keep ${JSON.stringify(nested)} for the next review.`,
      'Supporting subtree: work:///cards/project/tmp/evidence',
    ].join(newline);
    const { DURABLE_PRIMARY_CONTENT_POLICY } = await import('../../src/schemas/index.js');
    const inputId = randomUUID();
    const row = agentMessageSchema.parse({ ...message(`Record content: ${quoted ? JSON.stringify(body) : body}`),
      kind: 'record_prompt', instruction_origin: 'workflow_prompt',
      record_prompt: { reference: 'changed-record', node_id: 'plan', reason: 'changed' },
      context_policy: { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: false, compaction_key: 'record-brief' },
      record_observations: [{ observed: { card_id: 'project', record_name: 'brief.md', view: 'accepted', selection_kind: 'current',
        head: { head_id: inputId, revision: 1 }, selection: { kind: 'accepted', entry_id: inputId, version: 1,
          locator: 'record:///brief.md?card=project&v=1', content_sha256: 'a'.repeat(64) }, exposure: { kind: 'full_body' } },
        source: { kind: 'prompt', input_id: inputId, node_id: 'plan', reference: 'changed-record' } }] });
    appendConversationBatch({ projectRoot: root }, [row]);
    const files = [selected, nested, subtree, control, recent];
    const bytes = files.map(path => readFileSync(path));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ observed_count: 5, would_delete_count: 1, deleted_count: 0,
      retained: { protected: 3, recent: 1 } });
    expect(files.map(path => readFileSync(path))).toEqual(bytes);
  });

  it('protects an exact structured newline-bearing path independently of quotation inference', async () => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/line\nbreak.txt');
    const control = work(root, 'cards/project/tmp/control');
    baseline(root, JSON.stringify({ source_path: selected }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: 1 }, would_delete_count: 1, deleted_count: 0 });
    expect([selected, control].every(existsSync)).toBe(true);
  });

  it.each(['unknown', 'scoped'] as const)('preserves genuine quoted %s wildcard protection', async scope => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/evidence/inside');
    const control = work(root, 'cards/project/tmp/control');
    baseline(root, scope === 'unknown' ? 'Keep "*.txt"' : `Keep "${dirname(selected)}/*.txt"`);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: scope === 'unknown' ? 2 : 1 },
      would_delete_count: scope === 'unknown' ? 0 : 1, deleted_count: 0 });
    expect([selected, control].every(existsSync)).toBe(true);
  });

  it('protects complete matching-quoted common paths, Unicode and ASCII apostrophes, and escaped double quotes selectively', async () => {
    const root = fixture();
    const names = ['single dir/with space.txt', 'double dir/with space.txt', 'backtick dir/with space.txt',
      "data/O'Brien report.txt", 'data/O’Brien report.txt', 'escaped "name".txt', 'relative-basename.txt'];
    const selected = names.map(name => work(root, `cards/project/tmp/${name}`));
    const control = work(root, 'cards/project/tmp/control');
    baseline(root, [
      `Keep '${selected[0]}'`,
      'Keep ".saivage/work/cards/project/tmp/double dir/with space.txt"',
      'Keep `.saivage/work/cards/project/tmp/backtick dir/with space.txt`',
      "Keep '.saivage/work/cards/project/tmp/data/O'Brien report.txt'",
      "Keep '.saivage/work/cards/project/tmp/data/O’Brien report.txt'",
      `Keep ${JSON.stringify(selected[5])}`,
      "Keep 'relative-basename.txt'",
    ].join('\n'));
    const bytes = [...selected, control].map(path => readFileSync(path));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: selected.length }, would_delete_count: 1, deleted_count: 0 });
    expect([...selected, control].map(path => readFileSync(path))).toEqual(bytes);
  });

  it('protects structured space-containing paths and word-adjacent explicit URIs independently of the native quote heuristic', async () => {
    const root = fixture();
    const names = ['structured/with space.txt', 'uri/with space.txt', 'file/with space.txt', 'project/with space.txt',
      'system/with space.txt', 'work/with space.txt'];
    const selected = names.map(name => work(root, `cards/project/tmp/${name}`));
    const control = work(root, 'cards/project/tmp/control');
    const uris = ['tmp:///project/uri/with space.txt', `file://${selected[2]}`,
      'project:///.saivage/work/cards/project/tmp/project/with space.txt',
      `system:///${selected[4]!.slice(1)}`, 'work:///cards/project/tmp/work/with space.txt'];
    baseline(root, JSON.stringify({ source_path: selected[0], prose: uris.map(uri => `open(r'${uri}'r'')`).join('\n') }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: selected.length }, would_delete_count: 1, deleted_count: 0 });
    expect([...selected, control].every(existsSync)).toBe(true);
  });

  it.each(['r', 'é', '𝒓', '١', '_'])('discloses the accepted free-text word-adjacent native literal miss (%s) without deleting the old needed file', async prefix => {
    const root = fixture();
    const needed = work(root, 'cards/project/tmp/data/with space.txt');
    baseline(root, `open(${prefix}'data/with space.txt'${prefix}'')`);
    const bytes = readFileSync(needed);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ would_delete_count: 1, deleted_count: 0 });
    expect(readFileSync(needed)).toEqual(bytes);
  });

  it.each(['realpath', 'fallback lstat'] as const)('retains all on exact %s ENAMETOOLONG without candidate effects', async operation => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    const reference = join(root, 'recognized-reference');
    baseline(root, JSON.stringify({ source_path: reference }));
    const found = await inventory(root), realpath = fs.realpathSync, stat = fs.lstatSync;
    const observed: string[] = [];
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === reference) {
        observed.push('realpath');
        throw Object.assign(new Error('injected reference metadata failure'), { code: operation === 'realpath' ? 'ENAMETOOLONG' : 'ENOENT' });
      }
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    jest.spyOn(fs, 'lstatSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === reference) {
        observed.push('lstat');
        throw Object.assign(new Error('injected fallback metadata failure'), { code: 'ENAMETOOLONG' });
      }
      return (stat as any)(path, ...args);
    }) as typeof stat);
    const unlink = jest.spyOn(fs, 'unlinkSync');
    const bytes = readFileSync(candidate);
    const result = await collectWorkGarbage(found, { mode: 'delete' }, context());
    expect(result).toMatchObject({ retained: { protected: 1 }, deleted_count: 0 });
    expect(observed).toContain('realpath');
    expect(observed.includes('lstat')).toBe(operation === 'fallback lstat');
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(candidate)).toEqual(bytes);
  });

  it('conservatively retains a long synthetic backtick path without depending on host path limits', async () => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    const reference = `data/${'component/'.repeat(80)}${'x'.repeat(531)}`;
    baseline(root, `Evidence: \`${reference}\``);
    const found = await inventory(root), realpath = fs.realpathSync;
    let failures = 0;
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path).endsWith(reference)) {
        failures++;
        throw Object.assign(new Error('synthetic long path'), { code: 'ENAMETOOLONG' });
      }
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    const result = await collectWorkGarbage(found, { mode: 'dry_run' }, context());
    expect(failures).toBeGreaterThan(0);
    expect(result).toMatchObject({ retained: { protected: 1 }, would_delete_count: 0, deleted_count: 0 });
    expect(existsSync(candidate)).toBe(true);
  });

  it.each([['realpath', 'native'], ['fallback lstat', 'native'], ['realpath', 'file URI'], ['fallback lstat', 'file URI']] as const)('propagates unexpected non-filesystem exceptions from %s for a %s reference', async (operation, spelling) => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    const reference = join(root, 'recognized-reference');
    baseline(root, JSON.stringify({ source_path: spelling === 'native' ? reference : `file://${reference}` }));
    const found = await inventory(root), realpath = fs.realpathSync, stat = fs.lstatSync;
    const unexpected = new Error('unexpected metadata implementation failure');
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === reference) {
        if (operation === 'realpath') throw unexpected;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    jest.spyOn(fs, 'lstatSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === reference) throw unexpected;
      return (stat as any)(path, ...args);
    }) as typeof stat);
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context())).rejects.toBe(unexpected);
    expect(unlink).not.toHaveBeenCalled();
    expect(existsSync(candidate)).toBe(true);
  });

  it('protects inherited instructions and effective summary, not internal record facts or old summaries', async () => {
    const root = fixture(), inputId = randomUUID();
    const retained = work(root, 'cards/project/tmp/protected-prompt.txt');
    const summarized = work(root, 'cards/project/tmp/effective-summary.txt');
    const garbage = work(root, 'cards/project/tmp/control');
    const { DURABLE_PRIMARY_CONTENT_POLICY } = await import('../../src/schemas/index.js');
    const { deriveRequiredModelFacts, selectConversationProtection } = await import('../../src/contracts/conversation-validation.js');
    const row = agentMessageSchema.parse({ ...message('Actual record prompt: tmp:///project/protected-prompt.txt'), kind: 'record_prompt',
      instruction_origin: 'workflow_prompt', record_prompt: { reference: 'changed-record', node_id: 'plan', reason: 'changed' },
      context_policy: { ...DURABLE_PRIMARY_CONTENT_POLICY, compactable: false, compaction_key: 'record-brief' },
      record_observations: [{ observed: { card_id: 'project', record_name: 'brief.md', view: 'accepted', selection_kind: 'current',
        head: { head_id: inputId, revision: 1 }, selection: { kind: 'accepted', entry_id: inputId, version: 1,
          locator: 'record:///brief.md?card=project&v=1', content_sha256: 'a'.repeat(64) }, exposure: { kind: 'full_body' } },
        source: { kind: 'prompt', input_id: inputId, node_id: 'plan', reference: 'changed-record' } }] });
    appendConversationBatch({ projectRoot: root }, [row]);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const facts = deriveRequiredModelFacts({ inherited: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] },
      coveredRows: [row], source: segment.conversation });
    const { protectedPrompts } = selectConversationProtection({ inherited: [], rows: [row], sourceVersion: 1, cutoffCount: 1 });
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(2, entryId) },
      history: { summaryText: 'Prior task: tmp:///project/effective-summary.txt', protectedPrompts: [...protectedPrompts], requiredModelFacts: facts },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    const current = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const sources: unknown[] = [];
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, { content: async value => { sources.push(value); }, operational: async () => {} });
    expect(facts.latestRecordObservations).toHaveLength(1);
    expect(sources).toContain(row.content);
    expect(sources).toContain(current.conversation.effectiveCompactedHistory!.summaryText);
    expect(sources).not.toContainEqual(current.genesis);
    expect(sources).not.toContainEqual(facts);
    const { providerConversationProjection } = await import('../../src/runtime/actors/conversation-session.js');
    expect(JSON.stringify(providerConversationProjection(current.conversation, []))).not.toContain('latestRecordObservations');
    expect((await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context())).would_delete_count).toBe(1);
    expect((await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context())).deleted_count).toBe(1);
    expect(existsSync(retained)).toBe(true); expect(existsSync(summarized)).toBe(true); expect(existsSync(garbage)).toBe(false);
    const oldest = cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
    appendFileSync(oldest, '{malformed}\n'); const bytes = readFileSync(oldest);
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } }))).rejects.toThrow();
    expect(readFileSync(oldest)).toEqual(bytes);
  });
  it('releases completed bootstrap captures but retains an incomplete native index through strict canonical reads', async () => {
    const root = publicNativeProject();
    roots.push(root);
    // Preserve this public commissioning fixture as qualification evidence.
    const init = publicNativeCli(root, 'init', ...nativeOptions);
    expect(init.status).toBe(0);
    const { createResolvedConfigAuthority } = await import('../../src/config/resolved-config-authority.js');
    const { readCardExecutions } = await import('../../src/persistence/card-execution-log.js');
    const { readCard } = await import('../../src/persistence/card-files.js');
    const fresh = createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: process.env }).loadEffective();
    const bootstrap = readCardExecutions(root, 'project');
    expect(bootstrap.find(row => row.kind === 'native_started')?.binding).toEqual({ origin: 'bootstrap' });
    const starts = bootstrap.filter(row => row.kind === 'native_process_started');
    expect(starts.length).toBeGreaterThan(1);
    const captures = starts.flatMap(row => row.files.map(file => join(root, file.path)));
    const invocation = randomUUID();
    const indexRelative = `.saivage/work/cards/project/tmp/native-git-${invocation}/index`;
    const index = work(root, indexRelative.slice('.saivage/work/'.length), 'selected incomplete index');
    // A strict-valid incomplete activation prefix selects its artifact. No
    // fabricated completion, source effect or initialized conversation is needed.
    appendCardExecutions(root, 'project', [{ row_id: randomUUID(), invocation_id: invocation,
      card_id: 'project', timestamp: '2026-10-27T00:00:00.000Z', kind: 'native_started', step: 'captureRebase',
      binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null,
        node: { node_id: 'git-rebase-correction', ordinal: 1 } }, artifact_paths: [indexRelative] }]);
    const selected = [index, cardExecutionFile(root, 'project'),
      join(root, '.saivage/cards/project/card-head.json'), join(root, '.git/HEAD'),
      join(root, 'source.txt')].map(path => [path, readFileSync(path)] as const);
    const garbage = work(root, 'cards/project/tmp/unselected-control');
    const unlinked = join(root, '.saivage/cards/card-z/records'); mkdirSync(unlinked, { recursive: true });
    writeFileSync(join(unlinked, 'executions.jsonl'), 'malformed unlinked evidence\n');
    const ref = readCard(root, 'project')!.git!.branch_ref, oid = fixtureGit(root, 'rev-parse', ref);
    const gitIndex = readFileSync(join(root, '.git/index'));
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: Date.now() + 1000 },
      context({ workflows: fresh.workflows, operationalInputs: { config: fresh.config } }));
    expect(preview.would_delete_count).toBe(1 + captures.length);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete', before: Date.now() + 1000 },
      context({ workflows: fresh.workflows, operationalInputs: { config: fresh.config } }));
    expect(result.deleted_count).toBe(1 + captures.length);
    expect(captures.every(path => !existsSync(path))).toBe(true);
    expect(existsSync(garbage)).toBe(false);
    for (const [path, bytes] of selected) expect(readFileSync(path)).toEqual(bytes);
    expect(fixtureGit(root, 'rev-parse', ref)).toBe(oid);
    expect(readFileSync(join(root, '.git/index'))).toEqual(gitIndex);
    expect(readFileSync(join(unlinked, 'executions.jsonl'), 'utf8')).toBe('malformed unlinked evidence\n');
  }, 60_000);
  it('marks exact native captures and selected private index even for an incomplete attempt', async () => {
    const root = fixture(), invocation = randomUUID(), processId = 'proc-0123456789ab';
    const index = work(root, `cards/project/tmp/native-git-${invocation}/index`);
    const captures = ['stdout', 'stderr'].map(stream => work(root, `cards/project/processes/${processId}/${stream}.log`));
    const garbage = work(root, 'cards/project/tmp/unselected');
    const identity = { invocation_id: invocation, card_id: 'project', timestamp: '2026-10-25T00:00:00.000Z' };
    appendCardExecutions(root, 'project', [
      { ...identity, row_id: randomUUID(), kind: 'native_started', step: 'captureRebase',
        binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null, node: { node_id: 'git-rebase-correction', ordinal: 2 } },
        artifact_paths: [`.saivage/work/cards/project/tmp/native-git-${invocation}/index`] },
      { ...identity, row_id: randomUUID(), kind: 'native_process_started', process_id: processId, allowed_exit_codes: [0],
        files: (['stdout', 'stderr'] as const).map(stream => ({ kind: 'capture', stream,
          path: `.saivage/work/cards/project/processes/${processId}/${stream}.log` })) },
    ]);
    expect((await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context())).would_delete_count).toBe(1);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect([index, ...captures].every(existsSync)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
  });
  it('releases fully inline terminal captures like runtime while retaining typed webfetch/source query selections', async () => {
    const root = fixture(), processId = 'proc-0123456789ab';
    const captures = ['stdout', 'stderr'].map(stream => work(root, `processes/${processId}/${stream}.log`, 'output'));
    const stash = work(root, 'tmp/stash/webfetch-1-0123456789abcdef.txt', 'downloaded');
    const image = work(root, 'cards/project/tmp/source image.png');
    const querySource = work(root, 'cards/project/tmp/query-source.png');
    const garbage = work(root, 'cards/project/tmp/garbage');
    const content = JSON.stringify({ success: true, data: { process_id: processId, exit_code: 0, status: 'exited',
      stdout: 'output', stderr: 'output', stdout_complete: true, stderr_complete: true, stdout_bytes: 6, stderr_bytes: 6,
      stdout_url: `work:///processes/${processId}/stdout.log`, stderr_url: `work:///processes/${processId}/stderr.log` } });
    const policy = toolRowPolicies({ content, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
    const inputId = randomUUID(), callId = 'terminal-capture';
    const call = agentMessageSchema.parse({ ...message(''), id: `${inputId}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call',
      tool: 'run_command', tool_call_id: callId, context_policy: policy.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'run_command', arguments: '{}' } }] }) });
    const result = agentMessageSchema.parse({ ...message(content), id: `${inputId}:tool-result:${callId}`, role: 'tool', kind: 'tool_result',
      tool: 'run_command', tool_call_id: callId, context_policy: policy.result });
    const projection = composeContextProjection({ sourceSessionId: 'agent:planner:project', effectiveHistory: null, dynamicBlocks: [], uncoveredRows: [call, result] });
    const primary = providerConversationFromComposedContext(projection);
    expect(JSON.stringify(primary)).not.toContain('stdout_url');
    expect(JSON.stringify(primary)).not.toContain('stderr_url');
    appendConversationBatch({ projectRoot: root }, [call, result]);
    const webfetch = WebfetchTextDataSchema.parse({ kind: 'text', redacted_url: 'https://example.invalid/page', status: 200, headers: {},
      head: 'down', head_utf8_bytes: 4, redacted_text_utf8_bytes: 10, fetched_text_utf8_bytes: 10,
      head_complete: false, fetch_truncated: false, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt' });
    baseline(root, JSON.stringify({ webfetch, image: { source_path: 'tmp:///project/source%20image.png' },
      endpoint: `https://example.invalid/api/files/image?path=${encodeURIComponent('tmp:///project/query-source.png')}` }));
    const deleted = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(deleted.deleted_count).toBe(3);
    expect(captures.every(path => !existsSync(path))).toBe(true);
    expect([stash, image, querySource].every(existsSync)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
  });

  it.each([
    ['running', true, true], ['exited', false, true], ['exited', true, false], ['exited', true, true],
  ] as const)('collector stream liveness equals primary runtime projection: %s stdout=%s stderr=%s', async (status, stdout_complete, stderr_complete) => {
    const root = fixture(), processId = 'proc-0123456789ab';
    const captures = (['stdout', 'stderr'] as const).map(stream => work(root, `processes/${processId}/${stream}.log`, 'output'));
    const content = JSON.stringify({ success: true, data: { process_id: processId, status, exit_code: status === 'running' ? null : 0,
      stdout: 'output', stderr: 'output', stdout_complete, stderr_complete, stdout_bytes: 6, stderr_bytes: 6,
      stdout_url: `work:///processes/${processId}/stdout.log`, stderr_url: `work:///processes/${processId}/stderr.log` } });
    const rows = toolExchange('run_command', content);
    appendConversationBatch({ projectRoot: root }, rows);
    const primary = providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: 'agent:planner:project', effectiveHistory: null, dynamicBlocks: [], uncoveredRows: rows }));
    const visible = JSON.stringify(primary);
    const retained = [visible.includes('stdout_url'), visible.includes('stderr_url')];
    const deletion = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(deletion.deleted_count).toBe(retained.filter(value => !value).length);
    expect(captures.map(existsSync)).toEqual(retained);
  });

  it('selects current typed result data/content and unmatched arguments without scanning call policy or row provenance', async () => {
    const root = fixture();
    const names = ['result-data', 'result-text', 'call-argument', 'provenance-only'];
    const paths = names.map(name => work(root, `cards/project/tmp/${name}.txt`));
    const image = { id: randomUUID(), mime_type: 'image/png', width: 1, height: 1, byte_length: 1, sha256: 'a'.repeat(64) };
    const content = JSON.stringify({ success: true, data: { source_path: 'tmp:///project/result-data.txt' }, content: [
      { type: 'text', text: 'tmp:///project/result-text.txt' }, { type: 'image', image },
    ] });
    const rows = toolExchange('read', content);
    appendConversationBatch({ projectRoot: root }, rows);
    const unmatched = toolExchange('read', JSON.stringify({ success: true }), JSON.stringify({ path: 'tmp:///project/call-argument.txt' }))[0]!;
    appendConversationBatch({ projectRoot: root }, [unmatched]);
    const values: unknown[] = [];
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, { content: async value => { values.push(value); }, operational: async () => {} });
    expect(values).toContainEqual(image);
    expect(values).not.toContainEqual(rows[0]!.context_policy);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect(paths.map(existsSync)).toEqual([true, true, true, false]);
  });

  it('parses nested JSON as values rather than treating quoted instruction prose as a giant filesystem path', async () => {
    const root = fixture();
    const retained = work(root, 'cards/project/tmp/with space.txt');
    const garbage = work(root, 'cards/project/tmp/garbage');
    baseline(root, JSON.stringify({ instruction: `The owner's ${'ordinary guidance '.repeat(40)}child's task uses \`[[card:<id>]]\`.`,
      evidence: JSON.stringify({ source_path: 'tmp:///project/with space.txt' }) }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect(existsSync(retained)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
  });

  it('yields during inventory, then preview and delete use the same fresh mark and accounted target', async () => {
    const root = fixture();
    const a = work(root, 'cards/project/tmp/a.txt');
    const b = work(root, 'cards/project/tmp/b.txt');
    const c = work(root, 'cards/project/tmp/c.txt');
    const opaque = work(root, 'unknown/no-touch', 'unknown');
    const task = inventory(root);
    let completed = false;
    void task.then(() => { completed = true; });
    await setImmediate();
    expect(completed).toBe(false);
    const found = await task;
    expect(found.candidates).toHaveLength(3);
    expect(found.observed_logical_bytes).toBe(12);
    const identities = [a, b, c].map(path => [readFileSync(path), lstatSync(path).ino]);
    const options = { mode: 'dry_run' as const, targetBytes: 8 };
    const preview = await collectWorkGarbage(found, options, context());
    expect(preview).toMatchObject({ would_delete_count: 1, deleted_count: 0,
      expected_accounted_logical_bytes_remaining: 8, accounted_target_shortfall: 0,
      whole_work_size_known: false, retained: { target: 2 } });
    expect([a, b, c].map(path => [readFileSync(path), lstatSync(path).ino])).toEqual(identities);
    const removed = await collectWorkGarbage(await inventory(root), { ...options, mode: 'delete' }, context());
    expect(removed.deleted_logical_bytes).toBe(preview.would_delete_logical_bytes);
    expect(removed.deleted_count).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    expect(existsSync(dirname(a))).toBe(true);
    expect(readFileSync(opaque, 'utf8')).toBe('unknown');
  });

  it('marks a generic baseline added AFTER inventory, not merely declared record names', async () => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/selected.txt');
    const garbage = work(root, 'cards/project/scratch/garbage.txt');
    const found = await inventory(root);
    baseline(root, 'Keep `tmp:///project/selected.txt`.');
    const head = cardRecordHeadFile(root, 'project', definition());
    const bytes = readFileSync(head);
    const result = await collectWorkGarbage(found, { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect(result.retained.protected).toBe(1);
    expect(existsSync(selected)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
    expect(readFileSync(head)).toEqual(bytes);
  });

  it('retains changed, replaced, disappeared and symlink-swapped files; never expands inventory', async () => {
    const root = fixture();
    const changed = work(root, 'cards/project/tmp/changed');
    const replaced = work(root, 'cards/project/tmp/replaced');
    const vanished = work(root, 'cards/project/tmp/vanished');
    const alias = work(root, 'cards/project/tmp/alias');
    const found = await inventory(root);
    appendFileSync(changed, 'new');
    renameSync(replaced, `${replaced}.old`);
    writeFileSync(replaced, 'abcd');
    utimesSync(replaced, 1, 1);
    unlinkSync(vanished);
    unlinkSync(alias); symlinkSync(changed, alias);
    const fresh = work(root, 'cards/project/tmp/fresh');
    const result = await collectWorkGarbage(found, { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(0);
    expect(result.retained.stale).toBe(4);
    expect(existsSync(fresh)).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it('retains symlink-swapped ancestors and rejects a symlinked work root', async () => {
    const root = fixture();
    const path = work(root, 'cards/project/tmp/child/file');
    const found = await inventory(root);
    renameSync(dirname(path), `${dirname(path)}-old`);
    symlinkSync(`${dirname(path)}-old`, dirname(path));
    expect((await collectWorkGarbage(found, { mode: 'delete' }, context())).retained.stale).toBe(1);
    expect(existsSync(path)).toBe(true);
    const workRoot = join(root, '.saivage/work');
    renameSync(workRoot, `${workRoot}-old`); symlinkSync(`${workRoot}-old`, workRoot);
    await expect(inventory(root)).rejects.toThrow(/non-symlink/);
  });

  it('does not follow an ancestor swapped to a symlink across a background inventory yield', async () => {
    const root = fixture();
    const path = work(root, 'cards/project/tmp/deep/file');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'file'), 'outside');
    const stat = fs.lstatSync;
    let swapped = false;
    const accesses: string[] = [];
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: any, ...rest: any[]) => {
      accesses.push(String(target));
      const result = (stat as any)(target, ...rest);
      if (!swapped && String(target) === dirname(path)) {
        swapped = true;
        // The iterator yields between names; mutate before its child metadata consumption.
        void setImmediate().then(() => { renameSync(dirname(path), `${dirname(path)}-old`); symlinkSync(outside, dirname(path)); });
      }
      return result;
    }) as typeof stat);
    const found = await inventory(root);
    expect(swapped).toBe(true);
    expect(found.candidates).toHaveLength(0);
    expect(accesses).not.toContain(path);
    expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('outside');
  });

  it('retains tombstoned/unlinked work without discovering unlinked canonical namespaces', async () => {
    const root = fixture();
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'bounded', bootstrap_content: 'brief',
      created_by: 'analyst', depends_on: [] });
    const selected = work(root, `cards/${child.id}/tmp/retained`);
    const unknown = work(root, 'cards/card-z/tmp/unlinked');
    const garbage = work(root, 'cards/project/tmp/garbage');
    cards.deleteSubtrees([child.id], () => true);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect(result.retained.opaque).toBe(2);
    expect(existsSync(selected) && existsSync(unknown)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
  });

  it('uses strict mtime cutoff, ignores reserved work and record names, and preserves unreachable owners', async () => {
    const root = fixture();
    const old = work(root, 'cards/project/tmp/old', 'old', 999);
    const equal = work(root, 'cards/project/tmp/equal', 'equal', 1000);
    const newer = work(root, 'cards/project/tmp/newer', 'newer', 1001);
    const orphan = work(root, 'cards/card-z/tmp/orphan');
    // A broken reserved symlink must not be resolved or entered in accounting.
    const reserved = join(root, '.saivage/work/cards/project/tmp/.file.invalid.saivage-tmp');
    symlinkSync('/not-present', reserved);
    const records = cardRecordsRoot(root, 'project');
    for (const name of ['record-evil.prev.json', 'record-evil.json.saivage-tmp', 'other.json'])
      symlinkSync('/not-present', join(records, name));
    const found = await inventory(root);
    expect(found.opaque_entries).toBe(0);
    expect(found.candidates).toHaveLength(4);
    const result = await collectWorkGarbage(found, { mode: 'delete', before: 1000, targetBytes: 0 }, context());
    expect(result).toMatchObject({ deleted_count: 1, retained: { recent: 2, opaque: 1 }, accounted_target_shortfall: 14 });
    expect(existsSync(old)).toBe(false);
    expect([equal, newer, orphan].every(existsSync)).toBe(true);
    expect(lstatSync(reserved).isSymbolicLink()).toBe(true);
  });

  it('resolves project aliases first and handles spaces, native percent, URI percent, nested JSON and directory boundaries', async () => {
    const root = fixture();
    const paths = [
      'cards/project/tmp/dir/inside', 'cards/project/tmp/dirish/outside',
      'cards/project/tmp/with space.txt', 'cards/project/tmp/literal%20name.txt',
      'cards/project/tmp/encoded name.txt', 'cards/project/tmp/nested.txt',
    ].map(name => work(root, name));
    symlinkSync(join(root, '.saivage/work/cards/project/tmp/dir'), join(root, 'results'));
    baseline(root, [
      'Keep project:///results and `tmp:///project/with space.txt`.',
      `Native '${paths[3]}'`,
      'work:///cards/project/tmp/encoded%20name.txt',
      JSON.stringify({ payload: JSON.stringify({ source_path: 'tmp:///project/nested.txt' }) }),
    ].join('\n'));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result.deleted_count).toBe(1);
    expect(existsSync(paths[1]!)).toBe(false);
    expect(paths.filter((_, i) => i !== 1).every(existsSync)).toBe(true);
  });

  it('marks raw conversation references and refuses current torn tails without modifying bytes', async () => {
    const root = fixture();
    const protectedPath = work(root, 'cards/project/tmp/conversation.txt');
    const garbage = work(root, 'cards/project/tmp/garbage');
    appendConversationBatch({ projectRoot: root }, [message('Evidence: tmp:///project/conversation.txt')]);
    const found = await inventory(root);
    const preview = await collectWorkGarbage(found, { mode: 'dry_run' }, context());
    expect(preview.would_delete_count).toBe(1);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const path = cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
    appendFileSync(path, '{torn');
    const bytes = readFileSync(path);
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context())).rejects.toThrow(/tail repair/);
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(protectedPath) && existsSync(garbage)).toBe(true);
  });

  it('actually deletes only old history-only attachments, preserving current old references, recent files and every canonical byte', async () => {
    const root = fixture();
    const names = ['original', 'accepted-old', 'accepted-current', 'draft', 'pending', 'card-old', 'card-current', 'older-producer', 'context-current'];
    const paths = names.map(name => work(root, `cards/project/tmp/${name}.txt`));
    const recent = work(root, 'cards/project/tmp/recent', 'recent', 3000);
    const cards = new CardService(root);
    cards.editCard('project', { title: 'tmp:///project/card-old.txt' });
    cards.editCard('project', { title: 'tmp:///project/card-current.txt' });
    cards.acceptRecord('project', 'review-extra.md', 'tmp:///project/accepted-old.txt tmp:///project/older-producer.txt', { kind: 'agent', agent: 'analyst' });
    cards.acceptRecord('project', 'review-extra.md', 'tmp:///project/accepted-current.txt tmp:///project/older-producer.txt', { kind: 'agent', agent: 'analyst' });
    cards.openRecord('project', 'review-extra.md');
    cards.editRecord('project', 'review-extra.md', 'tmp:///project/draft.txt');
    cards.enqueueNotification('project', { id: randomUUID(), content: 'tmp:///project/pending.txt', created_at: '2026-10-24T00:00:00.000Z' });
    const row = message('tmp:///project/original.txt');
    appendConversationBatch({ projectRoot: root }, [row]);
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(2, entryId) },
      history: { summaryText: 'Old exchange summarized without a path.', protectedPrompts: [],
        requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    expect(JSON.stringify(readCurrentConversationSegment(root, 'agent:planner:project'))).not.toContain('original.txt');
    appendConversationBatch({ projectRoot: root }, [message('tmp:///project/context-current.txt')]);
    const before = await canonicalBytes(root);
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(preview).toMatchObject({ would_delete_count: 3, deleted_count: 0, retained: { protected: 6, recent: 1 } });
    expect(paths.every(existsSync)).toBe(true);
    expect(await canonicalBytes(root)).toEqual(before);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete', before: 2000 }, context());
    expect(result.deleted_count).toBe(3);
    for (const [i, name] of names.entries())
      expect(existsSync(paths[i]!)).toBe(!['original', 'accepted-old', 'card-old'].includes(name));
    expect(existsSync(recent)).toBe(true);
    expect(await canonicalBytes(root)).toEqual(before);
  });

  it.each(['card', 'record', 'conversation'] as const)('still refuses malformed consumed historical %s before deletion', async kind => {
    const root = fixture(), cards = new CardService(root);
    const candidate = work(root, 'cards/project/tmp/garbage');
    cards.editCard('project', { title: 'historical-card-marker' });
    cards.editCard('project', { title: 'current title' });
    cards.acceptRecord('project', 'review-extra.md', 'historical-record-marker', { kind: 'agent', agent: 'analyst' });
    cards.acceptRecord('project', 'review-extra.md', 'current record', { kind: 'agent', agent: 'analyst' });
    const row = message('historical-conversation-marker');
    appendConversationBatch({ projectRoot: root }, [row]);
    const old = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(2, entryId) },
      history: { summaryText: 'summary', protectedPrompts: [], requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    const consumed = await canonicalBytes(root);
    const path = kind === 'conversation' ? cardConversationVersionFile(root, 'project', 'planner', old.entry.filename)
      : [...consumed].find(([, bytes]) => bytes.toString().includes(`historical-${kind}-marker`))![0];
    expect(path).toBeDefined();
    writeFileSync(path, '{malformed historical}\n');
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context())).rejects.toThrow();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('{malformed historical}\n');
    expect(existsSync(candidate)).toBe(true);
  });

  it('never inspects filtered record/temp entries or enumerates canonical history siblings', async () => {
    const root = fixture();
    work(root, 'cards/project/tmp/garbage');
    const records = cardRecordsRoot(root, 'project');
    const ignored = ['record-x.prev.json', '.record-x.json.bad.saivage-tmp', 'random.json'];
    for (const name of ignored) writeFileSync(join(records, name), 'not canonical');
    const workTemp = join(root, '.saivage/work/cards/project/tmp/.capture.bad.saivage-tmp');
    writeFileSync(workTemp, 'not counted');
    const read = fs.readFileSync;
    const stat = fs.lstatSync;
    const open = fs.openSync;
    const opendir = fs.opendirSync;
    const accesses: string[] = [];
    jest.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...rest: any[]) => { accesses.push(String(path)); return (read as any)(path, ...rest); }) as typeof read);
    jest.spyOn(fs, 'lstatSync').mockImplementation(((path: any, ...rest: any[]) => { accesses.push(String(path)); return (stat as any)(path, ...rest); }) as typeof stat);
    jest.spyOn(fs, 'openSync').mockImplementation(((path: any, ...rest: any[]) => { accesses.push(String(path)); return (open as any)(path, ...rest); }) as typeof open);
    const directories: string[] = [];
    jest.spyOn(fs, 'opendirSync').mockImplementation(((path: any, ...rest: any[]) => { directories.push(String(path)); return (opendir as any)(path, ...rest); }) as typeof opendir);
    syncBuiltinESMExports();
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(result.would_delete_count).toBe(1);
    expect(accesses).not.toContain(workTemp);
    for (const name of ignored) expect(accesses).not.toContain(join(records, name));
    expect(directories.filter(path => !path.startsWith(join(root, '.saivage/work')))).toEqual([records]);
  });

  it('routes uncertain unlink immediately to fatal without descriptor cleanup or another effect', async () => {
    const root = fixture();
    const first = work(root, 'cards/project/tmp/a');
    const second = work(root, 'cards/project/tmp/b');
    const found = await inventory(root);
    const unlink = fs.unlinkSync;
    const open = fs.openSync;
    let descriptor: number | undefined;
    const effects: string[] = [];
    const close = jest.spyOn(fs, 'closeSync');
    jest.spyOn(fs, 'openSync').mockImplementation((path, flags) => {
      const fd = open(path, flags);
      if (String(path) === dirname(first)) descriptor = fd;
      return fd;
    });
    jest.spyOn(fs, 'unlinkSync').mockImplementation(path => {
      effects.push(String(path)); unlink(path); throw new Error('outcome unknown');
    });
    syncBuiltinESMExports();
    const fatal = jest.fn((error: Error): never => { effects.push('fatal'); throw error; });
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context({ fatal }))).rejects.toThrow();
    expect(effects).toEqual([first, 'fatal']);
    expect(fatal).toHaveBeenCalledTimes(1);
    // Canonical reads can close descriptors before the effect; none close after unlink.
    const unlinkOrder = (fs.unlinkSync as jest.Mock).mock.invocationCallOrder[0]!;
    expect(close.mock.invocationCallOrder.every(order => order < unlinkOrder)).toBe(true);
    expect(existsSync(second)).toBe(true);
    // The fake fatal boundary throws instead of exiting this synthetic process.
    fs.closeSync(descriptor!);
  });

  it('keeps known successful deletions in an interrupted result and never proceeds after cancellation', async () => {
    const root = fixture();
    const first = work(root, 'cards/project/tmp/a');
    const second = work(root, 'cards/project/tmp/b');
    const found = await inventory(root);
    const unlink = fs.unlinkSync;
    let cancelled = false;
    jest.spyOn(fs, 'unlinkSync').mockImplementation(path => { unlink(path); cancelled = true; });
    syncBuiltinESMExports();
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context({ assertCollecting: () => {
      if (cancelled) throw new Error('cancelled');
    } }))).rejects.toMatchObject({ name: 'WorkGcInterruptedError', result: { deleted_count: 1, deleted_logical_bytes: 4 } });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  it.each(['record', 'index', 'execution', 'segment'] as const)('fails strict %s corruption even after retain-all before any unlink', async kind => {
    const root = fixture();
    const candidate = work(root, 'cards/project/tmp/garbage');
    appendConversationBatch({ projectRoot: root }, [message('Retained evidence')]);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const path = kind === 'record' ? join(cardRecordsRoot(root, 'project'), 'record-generic.json')
      : kind === 'index' ? cardConversationVersionIndexFile(root, 'project', 'planner')
      : kind === 'segment' ? cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename)
      : cardExecutionFile(root, 'project');
    writeFileSync(path, '{broken}\n');
    const bytes = readFileSync(path);
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } }))).rejects.toThrow();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(candidate)).toBe(true);
  });

  it.each(['record', 'index', 'segment'] as const)('fails missing required %s even after retain-all without repair or unlink', async kind => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    appendConversationBatch({ projectRoot: root }, [message('Retained evidence')]);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const path = kind === 'record' ? join(cardRecordsRoot(root, 'project'), 'record-brief.json')
      : kind === 'index' ? cardConversationVersionIndexFile(root, 'project', 'planner')
      : cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
    unlinkSync(path);
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } }))).rejects.toThrow();
    expect(unlink).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(candidate)).toBe(true);
  });

  it.each(['looping', 'denied'] as const)('retains all for a recognized %s alias despite excluding unrelated possessive prose', async kind => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    const alias = join(root, 'alias');
    baseline(root, `The owner's resource/effect belongs to the child's task. Keep project:///alias/file`);
    if (kind === 'looping') symlinkSync(alias, alias);
    else {
      const realpath = fs.realpathSync;
      jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
        if (String(path) === join(alias, 'file')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (realpath as any)(path, ...args);
      }) as typeof realpath);
    }
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(result).toMatchObject({ retained: { protected: 1 }, would_delete_count: 0, deleted_count: 0 });
    expect(existsSync(candidate)).toBe(true);
  });

  it('marks incomplete execution captures, operational refs and entire draining capture directories', async () => {
    const root = fixture();
    const capture = work(root, 'cards/project/processes/proc/stdout.log');
    const stderr = work(root, 'cards/project/processes/proc/stderr.log');
    const active = work(root, 'processes/active/stdout.log');
    const activeErr = work(root, 'processes/active/stderr.log');
    const dependency = work(root, 'tmp/stash/dependency');
    const garbage = work(root, 'tmp/stash/garbage');
    const start: CardExecutionStart = { kind: 'invocation_started', row_id: randomUUID(), invocation_id: randomUUID(),
      card_id: 'project', timestamp: '2026-10-24T00:00:00.000Z', operation: 'shell.run', contract_version: 1,
      provider: { kind: 'builtin', name: 'shell' }, binding: { kind: 'node', activation_id: randomUUID(), node_id: 'run', ordinal: 0 },
      output_source: 'command-stdout', artifact_paths: [],
      input: [], config: [], shell: { script: 'echo hello', cwd: '/unrelated', argv: [], env: {} } };
    appendCardExecutions(root, 'project', [start, { kind: 'process_started', row_id: randomUUID(),
      invocation_id: start.invocation_id, card_id: 'project', timestamp: start.timestamp, process_id: 'proc',
      files: [{ kind: 'capture', stream: 'stdout', path: '.saivage/work/cards/project/processes/proc/stdout.log' },
        { kind: 'capture', stream: 'stderr', path: '.saivage/work/cards/project/processes/proc/stderr.log' }] }]);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({
      operationalInputs: { source_path: 'work:///tmp/stash/dependency' },
      protection: { retainAll: false, capturePaths: [active] },
    }));
    expect(result.deleted_count).toBe(1);
    expect([capture, stderr, active, activeErr, dependency].every(existsSync)).toBe(true);
    expect(existsSync(garbage)).toBe(false);
  });

  it.each([false, true])('completed action-output authorship alone never selects captures (current body reference: %s)', async referenced => {
    const root = fixture(), cards = new CardService(root), invocation = randomUUID(), activation = randomUUID();
    const processId = 'proc-123456789abc', timestamp = '2026-10-24T00:00:00.000Z';
    const files = (['stdout', 'stderr'] as const).map(stream => ({ kind: 'capture' as const, stream,
      path: `.saivage/work/cards/project/processes/${processId}/${stream}.log` }));
    const paths = files.map(file => work(root, file.path.slice('.saivage/work/'.length)));
    const content = referenced ? `Keep work:///cards/project/processes/${processId}/stdout.log` : 'Accepted inline output only';
    const output = { source: 'command-stdout' as const, size_bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
    const identity = { invocation_id: invocation, card_id: 'project', timestamp };
    appendCardExecutions(root, 'project', [
      { ...identity, row_id: randomUUID(), kind: 'invocation_started', operation: 'shell.run', contract_version: 1,
        provider: { kind: 'builtin', name: 'shell' }, binding: { kind: 'node', activation_id: activation, node_id: 'run', ordinal: 0 },
        output_source: 'command-stdout', artifact_paths: [], input: [], config: [], shell: { script: 'echo inline', cwd: '/unrelated', argv: [], env: {} } },
      { ...identity, row_id: randomUUID(), kind: 'process_started', process_id: processId, files },
      { ...identity, row_id: randomUUID(), kind: 'invocation_finished', disposition: 'returned', summary: 'Complete output',
        leader_exit: { exit_code: 0, signal: null, observed_at: timestamp }, leader_error: null, interruption: null, timeout_reason: null,
        process: { id: processId, group: 'absent', group_diagnostic: null, stdout: 'eof', stderr: 'eof', stdout_error: null, stderr_error: null },
        outcome: 'passed', values: [], files, output, absent_artifacts: [], external_effects: 'unknown' },
    ]);
    cards.acceptRecord('project', 'review-extra.md', content, { kind: 'action-output', operation: 'shell.run', contract_version: 1,
      provider: { kind: 'builtin', name: 'shell' }, activation_id: activation, invocation_id: invocation, node_id: 'run', ordinal: 0,
      process_id: processId, outcome: 'passed', output, leader_exit: { exit_code: 0, signal: null } });
    const before = await canonicalBytes(root);
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(preview.would_delete_count).toBe(referenced ? 1 : 2);
    const deleted = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(deleted.deleted_count).toBe(preview.would_delete_count);
    expect(existsSync(paths[0]!)).toBe(referenced);
    expect(existsSync(paths[1]!)).toBe(false);
    expect(await canonicalBytes(root)).toEqual(before);
    // Completed historical execution grammar remains strict even though it marks no work.
    appendFileSync(cardExecutionFile(root, 'project'), '{malformed historical}\n');
    const control = work(root, 'cards/project/tmp/control');
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context())).rejects.toThrow();
    expect(unlink).not.toHaveBeenCalled();
    expect(existsSync(control)).toBe(true);
  });

  it('unknown process footprints and unresolved aliases retain all, while cancellation stops before effects', async () => {
    const root = fixture();
    const candidate = work(root, 'cards/project/tmp/file');
    const found = await inventory(root);
    expect((await collectWorkGarbage(found, { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } }))).deleted_count).toBe(0);
    symlinkSync('/missing-target', join(root, 'broken'));
    baseline(root, 'project:///broken/file');
    expect((await collectWorkGarbage(found, { mode: 'delete' }, context())).retained.protected).toBe(1);
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context({ assertCollecting: () => { throw new Error('cancelled'); } }))).rejects.toThrow('cancelled');
    expect(existsSync(candidate)).toBe(true);
  });
});
