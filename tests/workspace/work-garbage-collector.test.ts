import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
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
const { collectWorkGarbage, inventoryWorkGarbage, WorkGcReferenceScopeError } = await import('../../src/workspace/work-garbage-collector.js');
const { OPERATIONAL_RESULT_POLICY_TEMPLATE } = await import('../../src/tools/invocation.js');
const { toolRowPolicies } = await import('../helpers/row-policy-fixtures.js');
const { composeContextProjection, providerConversationFromComposedContext } = await import('../../src/runtime/actors/context/composition-projector.js');
const { inspectWorkGcCanonicalState } = await import('../../src/persistence/current-generated-graph.js');
const { cardAgentSessionId } = await import('../../src/schemas/index.js');
const { compactWorkGcCard } = await import('../helpers/work-gc-compaction.js');
const { buildCardworkUrl, settleToolActionOutcome } = await import('../../src/contracts/index.js');
const { invokeToolForLlm } = await import('../../src/tools/invocation.js');
const { workspaceToolBinders } = await import('../../src/tools/workspace-provider.js');
const { webToolBinders } = await import('../../src/tools/web-tools.js');
const { bindToolProvider } = await import('../helpers/bind-tool-provider.js');
const { buildInvocationSurfaceFixture } = await import('../helpers/invocation-surface-fixture.js');
const { testWorkspaceAuthority } = await import('../helpers/capability-grants.js');
const { testLlmToolInvocationContext } = await import('../helpers/llm-test-helpers.js');
const { workGcOperationalInputs, workGcFailureResponse } = await import('../../src/application/work-gc-operation.js');
const { surfaceToolContracts } = await import('../../src/tools/runtime-tool-catalog.js');
const { admitRecordMutation, mutateRecord } = await import('../../src/application/record-mutation-service.js');
const { appendLlmTurnToolCallBatch, buildSettledToolResult, selectInvocationResultPolicy } = await import('../../src/runtime/actors/llm-delivery-log.js');

const ignoreReferences = {
  content: async () => {}, operational: async () => {}, conversation: async () => {},
  path: async () => {}, dependencies: async () => {},
};
function captureReferences(values: unknown[]) {
  return { ...ignoreReferences,
    conversation: async (reference: Parameters<Parameters<typeof inspectWorkGcCanonicalState>[3]['conversation']>[0]) => {
      if (reference.kind === 'content') values.push(reference.value);
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(compacted = true): string {
  const root = mkdtempSync(join(tmpdir(), 'work-gc-test-'));
  roots.push(root);
  initProjectTree(root);
  if (compacted) compactWorkGcCard(root, TEST_WORKFLOWS);
  return root;
}
function work(root: string, name: string, content = 'abcd', time = 1000): string {
  const owner = /^cards\/(project|card-[a-z-]+)\//u.exec(name)?.[1];
  if (owner && owner !== 'project' && new CardService(root).read(owner)) compactWorkGcCard(root, TEST_WORKFLOWS, owner);
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
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, ignoreReferences);
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

function boundWorkspace(root: string) {
  const store = new CardService(root);
  const authority = testWorkspaceAuthority('project');
  const agentName = 'planner' as const;
  const context = { projectRoot: root, cardId: 'project', agentName, authority, store,
    recordMutations: {
      admit: (request: Parameters<typeof admitRecordMutation>[1]) => admitRecordMutation(store, request),
      mutate: (request: Parameters<typeof mutateRecord>[1]) => mutateRecord(store, request),
    } };
  const surface = buildInvocationSurfaceFixture(agentName, [
    bindToolProvider('workspace', workspaceToolBinders, context),
    bindToolProvider('web', webToolBinders, context),
  ]);
  return async (tool: string, args: object, keep?: 'call' | 'receipt' | 'both') => {
    const sessionId = 'agent:planner:project' as const, inputId = randomUUID(), toolCallId = randomUUID();
    const result = await invokeToolForLlm(surface, tool, args,
      testLlmToolInvocationContext({ sessionId, sourceInputId: inputId, toolCallId, toolName: tool }),
      new AbortController().signal);
    if (keep) {
      const input = { sessionId, inputId, compiledToolContracts: surfaceToolContracts(surface) } as
        Parameters<typeof appendLlmTurnToolCallBatch>[1];
      const resultPolicy = selectInvocationResultPolicy(input, tool);
      const settled = buildSettledToolResult({ session_id: sessionId, source_input_id: inputId,
        tool_call_id: toolCallId, tool_name: tool, resultPolicy, settlement: result });
      if (keep !== 'receipt')
        appendLlmTurnToolCallBatch({ projectRoot: root }, input,
          { id: toolCallId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }, resultPolicy);
      if (keep !== 'call') appendConversationBatch({ projectRoot: root }, [settled.message]);
      return { ...settled.facts, row: settled.message };
    }
    return settleToolActionOutcome(result.kind === 'executed' ? result.execution.providerOutcome : result.providerOutcome);
  };
}

const publicUrl = (...pathSegments: string[]) =>
  buildCardworkUrl({ cardId: 'project', area: 'public', pathSegments });
const cardworkPreview = async (root: string) =>
  collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
const oneCharacterCases = (count: number) =>
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].slice(0, count).map(char => `case${char}.ts`);

describe('exact cardwork retention', () => {
  it.each(['refused', 'applied'] as const)('marks only the %s bound write’s actual settled result in the current conversation', async outcome => {
    const root = fixture(), invoke = boundWorkspace(root);
    const path = publicUrl(outcome === 'refused' ? 'tok_example_fixture.ts' : 'ordinary.ts');
    const selected = work(root, 'cards/project/public/ordinary.ts', 'selected');
    const control = work(root, 'cards/project/public/tok_example_fixture.ts', 'old');
    const settled = await invoke('write', { path, content: 'selected' });
    if (outcome === 'applied') {
      expect(settled.providerResult).toMatchObject({ success: true, data: { target: path } });
      expect((await invoke('read', { path })).providerResult).toMatchObject({
        success: true, data: { path, content: { content: 'selected' } },
      });
      utimesSync(selected, 1, 1);
    } else {
      expect(settled.providerResult).toEqual({
        success: false, error: 'Cardwork address cannot be represented as an unchanged receipt.',
      });
      expect(readFileSync(control, 'utf8')).toBe('old');
    }
    appendConversationBatch({ projectRoot: root }, toolExchange('write', settled.settledResultBytes));
    expect(await cardworkPreview(root)).toMatchObject({
      observed_count: 2, first_global_protection: null, retained: { protected: outcome === 'applied' ? 1 : 0 },
      would_delete_count: outcome === 'applied' ? 1 : 2,
      would_delete_logical_bytes: outcome === 'applied' ? 3 : 11,
    });
  });

  const carriers = {
    receipt: (_: string, bytes: string) => bytes,
    comma: (url: string) => `Keep ${url}, then continue`,
    parenthesized: (url: string) => `(keep ${url})`,
    adjacentParens: (url: string) => `Keep (${url})`,
    delimiters: (url: string) => `Keep ${url};:)]}, then continue`,
    single: (url: string) => `Keep '${url}'`,
    double: (url: string) => `Keep "${url}"`,
    backtick: (url: string) => `Keep \`${url}\`.`,
    markdown: (url: string) => `[selected](${url})`,
    angleMarkdown: (url: string) => `[selected](<${url}>)`,
    enclosingQuery: (url: string) => {
      const outer = new URL('https://example.invalid/fixture');
      outer.searchParams.set('selected', url);
      return outer.href;
    },
    nestedJson: (url: string) => JSON.stringify({ outer: JSON.stringify({ target: url }) }),
    patternSlot: (url: string) => JSON.stringify({ pattern: { literal: [url] } }),
  };
  const copies = Object.entries(carriers).flatMap(([kind, carrier]) =>
    (['write', 'webfetch'] as const).map(tool => ({ kind, carrier, tool })));
  it.each(copies)('protects one literal filename for $tool via $kind, even among more than fifty matches', async ({ tool, carrier }) => {
    const root = fixture(), invoke = boundWorkspace(root);
    for (const name of ['case%3F.ts', 'case?.ts', 'case*.ts', ...oneCharacterCases(52), 'control.txt'])
      work(root, `cards/project/public/${name}`, 'x');
    const name = tool === 'write' ? 'case?.ts' : 'case*.ts';
    const path = publicUrl(name), content = 'selected only';
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(content));
    const { settledResultBytes, providerResult } = tool === 'write'
      ? await invoke(tool, { path, content })
      : await invoke(tool, { url: 'https://93.184.216.34', save_as: path });
    expect(providerResult.success).toBe(true);
    if (!providerResult.success) throw new Error(providerResult.error);
    const target = tool === 'write'
      ? (providerResult.data as { target: string }).target
      : (providerResult.data as { write: { data: { target: string } } }).write.data.target;
    expect(target).toBe(`cardwork:///project/public/${tool === 'write' ? 'case%3F.ts' : 'case%2A.ts'}`);
    if (tool === 'webfetch') expect(providerResult.data).toHaveProperty('saved_as', target);
    expect(fetch).toHaveBeenCalledTimes(tool === 'webfetch' ? 1 : 0);
    expect((await invoke('read', { path: target })).providerResult).toMatchObject({
      success: true, data: { path: target, content: { content } },
    });
    utimesSync(join(root, '.saivage/work/cards/project/public', name), 1, 1);
    appendConversationBatch({ projectRoot: root }, [message(carrier(target, settledResultBytes))]);
    expect(await cardworkPreview(root)).toMatchObject({
      observed_count: 56, first_global_protection: null, retained: { protected: 1 },
      would_delete_count: 55, would_delete_logical_bytes: 55,
    });
  });

  it.each(['bare', 'query', 'Markdown query'] as const)
  ('decodes exactly once and retains escaped punctuation and an unreserved terminal period in %s', async kind => {
    const root = fixture(), invoke = boundWorkspace(root);
    const path = publicUrl('case%3F,.ts.');
    const selected = work(root, 'cards/project/public/case%3F,.ts.', 'selected');
    for (const name of ['case?,.ts.', 'case%3F,.ts', 'control'])
      work(root, `cards/project/public/${name}`, 'x');
    expect(path).toBe('cardwork:///project/public/case%253F%2C.ts.');
    expect((await invoke('read', { path })).providerResult).toMatchObject({
      success: true, data: { path, content: { content: 'selected' } },
    });
    expect(readFileSync(selected, 'utf8')).toBe('selected');
    const enclosing = carriers.enclosingQuery(path);
    baseline(root, kind === 'bare' ? `Keep ${path}, then continue.`
      : kind === 'query' ? enclosing : `[selected](<${enclosing}>)`);
    expect(await cardworkPreview(root)).toMatchObject({
      first_global_protection: null, retained: { protected: 1 }, would_delete_logical_bytes: 3,
    });
  });

  it.each([
    ['target punctuation', JSON.stringify({ target: `${publicUrl('one.ts')},` })],
    ['quoted punctuation', `Keep "${publicUrl('one.ts')},"`],
    ['prose quote with an unencoded escape', String.raw`Keep "cardwork:///project/public/one\u002Ets"`],
    ['Markdown punctuation', `[selected](${publicUrl('one.ts')},)`],
    ['Markdown angle destination with raw parenthesis', '[selected](<cardwork:///project/public/one).ts>)'],
    ['query punctuation', carriers.enclosingQuery(`${publicUrl('one.ts')},`)],
    ['query whitespace', carriers.enclosingQuery(` ${publicUrl('one.ts')}`)],
    ['raw NUL in an exact target', JSON.stringify({ target: `${publicUrl('one.ts')}\0` })],
    ['uppercase scheme', 'CARDWORK:///project/public/one.ts'],
    ['parenthesized raw wildcard', 'Keep (cardwork:///project/public/one*.ts)'],
    ['interior noncanonical escape', 'Keep cardwork:///project/public/one%2fescape.ts, please'],
    ['raw wildcard in pattern', JSON.stringify({ pattern: 'cardwork:///project/public/*.ts' })],
    ['malformed directory', 'directory="cardwork:///project/public/%ZZ", pattern="*.ts"'],
  ])('discards the unbounded suggestion for %s instead of guessing', async (_, content) => {
    const root = fixture();
    work(root, 'cards/project/public/one.ts');
    work(root, 'tmp/stash/unrelated');
    baseline(root, content);
    expect(await cardworkPreview(root)).toMatchObject({
      first_global_protection: null,
      retained: { protected: 0 }, would_delete_count: 2,
    });
  });

  const scopes = ['structured', 'nested cwd', 'prose', 'nested prose', 'broad with exact'] as const;
  it.each(scopes.flatMap(kind => [50, 51].map(count => ({ kind, count }))))
  ('uses a cardwork base only for $kind relative patterns at $count matches', async ({ kind, count }) => {
    const root = fixture(), directory = publicUrl('scope?');
    const pattern = 'case?.ts', names = oneCharacterCases(count);
    for (const name of names) work(root, `cards/project/public/scope?/${name}`);
    work(root, 'cards/project/public/scope?/not-a-match.txt');
    work(root, `cards/project/public/scopeZ/${names[0]}`);
    const pair = `directory="${directory}", pattern="${pattern}"`;
    const exact = publicUrl('scope?', names[0]!);
    const input = {
      structured: JSON.stringify({ directory, pattern }),
      'nested cwd': JSON.stringify({ nested: JSON.stringify({ cwd: directory, pattern: { literal: [pattern] } }) }),
      prose: pair,
      'nested prose': JSON.stringify({ nested: JSON.stringify({ text: pair }) }),
      'broad with exact': JSON.stringify({ directory, pattern, target: exact }),
    }[kind];
    baseline(root, input);
    const kept = count === 50 ? 50 : kind === 'broad with exact' ? 1 : 0;
    expect(await cardworkPreview(root)).toMatchObject({
      observed_count: count + 2, first_global_protection: null,
      retained: { protected: kept }, would_delete_count: count + 2 - kept,
    });
  });

  it.each(['parent glob', 'exact work URL', 'exact shell scope'] as const)
  ('compares old and converted physical layouts independently for a %s', async kind => {
    for (const converted of [false, true]) {
      const root = fixture(), area = converted ? 'public' : 'shell';
      const selected = work(root, `cards/project/${area}/install-check/result.ts`, 'selected');
      const control = work(root, `cards/project/${area}/unrelated.ts`, 'x');
      const legacy = 'work:///cards/project/shell/install-check/result.ts';
      const input = {
        'parent glob': { directory: 'work:///cards/project', pattern: 'shell*/install-check/result.ts' },
        'exact work URL': { path: legacy },
        'exact shell scope': { directory: 'work:///cards/project/shell', pattern: 'install-check/result.ts' },
      }[kind];
      if (converted) {
        const shell = join(root, '.saivage/work/cards/project/shell');
        symlinkSync('public', shell);
        expect(readFileSync(join(shell, 'install-check/result.ts'), 'utf8')).toBe('selected');
        const invoke = boundWorkspace(root);
        expect((await invoke('read', { path: legacy })).providerResult).toMatchObject({
          success: true, data: { content: { content: 'selected' } },
        });
        for (const path of [join(shell, 'install-check/result.ts'), legacy])
          expect((await invoke('write', { path, content: 'no alias write' })).providerResult.success).toBe(false);
        expect(readFileSync(selected, 'utf8')).toBe('selected');
      }
      baseline(root, JSON.stringify(input));
      const kept = converted && kind === 'parent glob' ? 0 : 1;
      expect(await cardworkPreview(root)).toMatchObject({
        observed_count: 2, observed_logical_bytes: 9, opaque_entries: converted ? 1 : 0,
        first_global_protection: null, retained: { protected: kept }, would_delete_logical_bytes: kept ? 1 : 9,
      });
      expect([selected, control].every(existsSync)).toBe(true);
    }
  });

  it.each(['known', 'absent', 'unknown scope'] as const)
  ('keeps converted aliases opaque with a %s card horizon/scope and resolves exact public and repos roots', async kind => {
    const root = fixture(kind !== 'absent');
    work(root, 'cards/project/public/purpose/readme.ts');
    work(root, 'cards/project/repos/checkout/where-plan.ts');
    work(root, 'cards/project/repos/other/control.ts');
    work(root, 'tmp/stash/global-control');
    symlinkSync('public', join(root, '.saivage/work/cards/project/shell'));
    if (kind === 'unknown scope')
      baseline(root, JSON.stringify({ directory: 'work:///cards/project/shell/${unknown}', pattern: '*.ts' }));
    else baseline(root, `${publicUrl()} cardwork:///project/repos/checkout`);
    const protectedCount = kind === 'known' ? 2 : kind === 'absent' ? 3 : 0;
    expect(await cardworkPreview(root)).toMatchObject({
      observed_count: 4, opaque_entries: 1, retained: { protected: protectedCount },
      first_global_protection: null,
      would_delete_count: 4 - protectedCount,
    });
  });

  it('does not turn cross-card URLs into graph discovery or same-card paths', async () => {
    const root = fixture(), cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Linked', bootstrap_content: 'brief',
      created_by: 'analyst', depends_on: [] });
    work(root, `cards/${child.id}/repos/checkout/selected.ts`, 'exact');
    work(root, 'cards/project/repos/checkout/selected.ts', 'x');
    work(root, 'cards/card-z/public/opaque.ts');
    const opaque = join(root, '.saivage/cards/card-z/card-head.json');
    mkdirSync(dirname(opaque), { recursive: true });
    writeFileSync(opaque, 'not a canonical card');
    baseline(root, `Keep cardwork:///${child.id}/repos/checkout/selected.ts and cardwork:///card-z/public/opaque.ts`);
    const read = jest.spyOn(fs, 'readFileSync');
    expect(await cardworkPreview(root)).toMatchObject({
      observed_count: 3, first_global_protection: null, retained: { protected: 1, opaque: 1 },
      would_delete_logical_bytes: 1,
    });
    expect(read.mock.calls.some(([path]) => String(path) === opaque)).toBe(false);
  });

  it('keeps a canonical cardwork reference independent of managed receipt policy', async () => {
    const root = fixture();
    work(root, 'cards/project/public/tok_example_fixture.ts', 'selected');
    work(root, 'cards/project/public/neighbor.ts', 'x');
    baseline(root, JSON.stringify({ target: publicUrl('tok_example_fixture.ts') }));
    expect(await cardworkPreview(root)).toMatchObject({
      first_global_protection: null, retained: { protected: 1 }, would_delete_logical_bytes: 1,
    });
  });

  it('does not protect files from a superseded conversation segment', async () => {
    const root = fixture();
    work(root, 'cards/project/public/old.ts', 'old reference');
    work(root, 'cards/project/public/current.ts', 'current reference');
    const row = message(`Keep ${publicUrl('old.ts')}`);
    appendConversationBatch({ projectRoot: root }, [row]);
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 3,
        timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(3, entryId) },
      history: { summaryText: `Keep ${publicUrl('current.ts')}`, protectedPrompts: [],
        requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    expect(await cardworkPreview(root)).toMatchObject({
      first_global_protection: null, retained: { protected: 1 }, would_delete_logical_bytes: 13,
    });
  });
});

describe('work GC two-phase selection', () => {
  it.each(['empty', 'ordinary', 'no_agents'] as const)('retains the card work area without a %s compaction boundary', async kind => {
    const root = fixture(false);
    const paths = [work(root, 'cards/project/tmp/old'), work(root, 'tmp/stash/global-old')];
    if (kind === 'ordinary') appendConversationBatch({ projectRoot: root }, [message('ordinary genesis')]);
    if (kind !== 'no_agents')
      compactWorkGcCard(root, TEST_WORKFLOWS, 'project', agent => agent === 'planner' ? null : '2026-10-25T00:00:00Z');
    const workflows = kind === 'no_agents' ? {
      ...TEST_WORKFLOWS, cardTypes: new Map([...TEST_WORKFLOWS.cardTypes].map(([type, workflow]) =>
        [type, { ...workflow, states: new Map() }])),
    } : TEST_WORKFLOWS;
    await parity(root, paths, [paths[0]!], { workflows });
  });

  it('uses the minimum of every unique configured session and retains equality using mtime, not new ctime', async () => {
    const root = fixture(false), early = Date.parse('2026-10-25T00:00:00Z');
    let sessions = 0;
    compactWorkGcCard(root, TEST_WORKFLOWS, 'project', () =>
      new Date(early + sessions++ * 1000).toISOString());
    expect(sessions).toBeGreaterThan(1);
    const paths = [
      work(root, 'cards/project/tmp/older', 'data', early - 1),
      work(root, 'cards/project/tmp/equal', 'data', early),
      work(root, 'cards/project/tmp/newer', 'data', early + 1),
      work(root, 'tmp/stash/global', 'data', early + 1),
    ];
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(result).toMatchObject({ would_delete_count: 2, retained: { protected: 2 } });
    expect(lstatSync(paths[0]!).ctimeMs).toBeGreaterThan(early);
    const cutoff = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: early - 1 }, context());
    expect(cutoff).toMatchObject({ would_delete_count: 0, retained: { recent: 4 } });
    const horizons = await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, ignoreReferences);
    expect(horizons.get('project')).toBe(early);
  });

  it('keeps cross-card and global references from a wholly horizon-retained card', async () => {
    const root = fixture(), cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief',
      created_by: 'analyst', depends_on: [] });
    const paths = [work(root, 'cards/project/tmp/own', 'data', Date.now()),
      work(root, `cards/${child.id}/tmp/selected`), work(root, 'tmp/stash/selected'),
      work(root, `cards/${child.id}/tmp/control`)];
    baseline(root, JSON.stringify({ paths: [`work:///cards/${child.id}/tmp/selected`, 'work:///tmp/stash/selected'] }));
    await parity(root, paths, paths.slice(0, 3));
  });

  it.each(['```BaSh extra\n./shell-only.txt\n```', '~~~zsh\n./shell-only.txt\n~~~',
    '~~~shell\n./shell-only.txt', '```sh\n~~~\n./shell-only.txt\n```'])(
    'masks only matching explicit shell fences: %s', async fence => {
      const root = fixture(), paths = ['shell-only.txt', 'prose.txt', 'inline.txt', 'unlabelled.txt']
        .map(name => work(root, `cards/project/tmp/${name}`));
      baseline(root, JSON.stringify({ nested: `${fence}\n./prose.txt \`./inline.txt\`\n\`\`\`\n./unlabelled.txt\n\`\`\`` }));
      const unclosed = fence === '~~~shell\n./shell-only.txt';
      await parity(root, paths, unclosed ? [] : paths.slice(1));
    });

  it('ignores known shell arguments and ignored current row contents before alias resolution, but retains literal prose', async () => {
    const root = fixture(), paths = ['shell-only.txt', 'literal.txt', 'control']
      .map(name => work(root, `cards/project/tmp/${name}`));
    const rows = toolExchange('run_command', JSON.stringify({ success: false, error: './literal.txt' }),
      JSON.stringify({ command: 'cat tmp:///project/shell-only.txt', cwd: 'jobs/${name}' }));
    appendConversationBatch({ projectRoot: root }, rows);
    const current = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const path = cardConversationVersionFile(root, 'project', 'planner', current.entry.filename);
    appendFileSync(path, JSON.stringify({ version: 13, type: 'conversation-segment', rows: [
      { session_id: 'agent:planner:project', kind: 'provider_private', content: 'tmp:///project/ignored-only' },
    ] }) + '\n');
    const realpath = fs.realpathSync;
    const resolutions: string[] = [];
    jest.spyOn(fs, 'realpathSync').mockImplementation(((input: any, ...args: any[]) => {
      resolutions.push(String(input)); return (realpath as any)(input, ...args);
    }) as typeof realpath);
    expect(await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context()))
      .toMatchObject({ would_delete_count: 2, retained: { protected: 1 } });
    expect(resolutions.some(value => value.includes('shell-only') || value.includes('ignored-only'))).toBe(false);
    expect(paths.every(existsSync)).toBe(true);
  });

  it.each(['empty', 'recent'] as const)('does no canonical read or alias resolution for an unconditionally %s inventory', async kind => {
    const root = fixture();
    if (kind === 'recent') work(root, 'cards/project/tmp/recent', 'data', 2000);
    const found = await inventory(root);
    const read = jest.spyOn(fs, 'readFileSync'), realpath = jest.spyOn(fs, 'realpathSync');
    expect(await collectWorkGarbage(found, { mode: 'dry_run', before: 1000 }, context({
      operationalInputs: { path: '/must-not-resolve' }, protection: { retainAll: false, capturePaths: ['/must-not-resolve'] },
    }))).toMatchObject({ would_delete_count: 0 });
    expect(read).not.toHaveBeenCalled(); expect(realpath).not.toHaveBeenCalled();
  });

  it('reads each current owner selection once and never resolves discarded current provenance or finished payloads', async () => {
    const root = fixture(), cards = new CardService(root);
    work(root, 'cards/project/tmp/control');
    cards.acceptRecord('project', 'review-extra.md', 'first accepted', { kind: 'agent', agent: 'analyst' });
    cards.acceptRecord('project', 'review-extra.md', 'current accepted', { kind: 'agent', agent: 'analyst' });
    const headPath = join(root, '.saivage/cards/project/card-head.json');
    const head = JSON.parse(readFileSync(headPath, 'utf8'));
    const cardPath = join(root, '.saivage/cards/project/card-history', `${head.ordinary.entry_id}.json`);
    const recordPath = cardRecordHeadFile(root, 'project', definition());
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const acceptedPath = join(cardRecordsRoot(root, 'project'), 'accepted', `${record.accepted.entry_id}.json`);
    const discarded = join(root, 'discarded-current-only');
    const card = JSON.parse(readFileSync(cardPath, 'utf8'));
    card.change = { path: discarded }; card.card.git = { path: discarded };
    writeFileSync(cardPath, JSON.stringify(card) + '\n');
    record.schema = { path: discarded };
    writeFileSync(recordPath, JSON.stringify(record) + '\n');
    const accepted = JSON.parse(readFileSync(acceptedPath, 'utf8'));
    accepted.predecessor = { path: discarded };
    accepted.accepted.author = { path: discarded };
    accepted.accepted.content_sha256 = false;
    writeFileSync(acceptedPath, JSON.stringify(accepted) + '\n');
    const invocation_id = randomUUID();
    writeFileSync(cardExecutionFile(root, 'project'), JSON.stringify({
      version: 3, type: 'card-execution', rows: [
        { kind: 'invocation_started', invocation_id, card_id: 'project', artifact_paths: [discarded],
          shell: { script: discarded, argv: [discarded] } },
        { kind: 'invocation_finished', invocation_id, card_id: 'project', process: { path: discarded } },
      ],
    }) + '\n');
    writeFileSync(join(root, '.saivage/cards/project/card-head.prev.json'), 'poisoned previous slot');
    const reads = new Map<string, number>(), resolutions: string[] = [];
    const read = fs.readFileSync, realpath = fs.realpathSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
      reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
      return (read as any)(path, ...args);
    }) as typeof read);
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      resolutions.push(String(path)); return (realpath as any)(path, ...args);
    }) as typeof realpath);
    expect(await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context()))
      .toMatchObject({ would_delete_count: 1 });
    for (const path of [headPath, cardPath, recordPath, acceptedPath]) expect(reads.get(path)).toBe(1);
    expect([...reads.keys()].some(path => path.endsWith('.prev.json'))).toBe(false);
    expect(resolutions).not.toContain(discarded);
    expect(() => cards.read('project')).toThrow();
  });

  async function parity(root: string, paths: readonly string[], kept: readonly string[],
    overrides: Partial<WorkGcCollectionContext> = {}) {
    const bytes = await canonicalBytes(root);
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context(overrides));
    expect(preview).toMatchObject({ first_global_protection: null, observed_count: paths.length,
      retained: { protected: kept.length }, would_delete_count: paths.length - kept.length });
    expect(paths.every(existsSync)).toBe(true);
    const deleted = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context(overrides));
    expect(deleted.deleted_count).toBe(preview.would_delete_count);
    expect(deleted.deleted_logical_bytes).toBe(preview.would_delete_logical_bytes);
    expect(paths.filter(existsSync)).toEqual(paths.filter(path => kept.includes(path)));
    expect(paths.map(dirname).every(existsSync)).toBe(true);
    expect(await canonicalBytes(root)).toEqual(bytes);
  }

  describe('GC-05 disjoint scope pruning', () => {
    it('walks no additional candidates for distinct disjoint structured patterns', async () => {
      const root = fs.realpathSync(fixture());
      for (let i = 0; i < 4; i++) {
        work(root, `cards/project/tmp/old-${i}.dat`);
        work(root, `tmp/stash/old-${i}.dat`);
      }
      const patterns = [
        { directory: join(root, '.saivage/work-other'), pattern: 'old-*.dat' },
        { directory: join(root, 'docs'), pattern: 'notes-*.md' },
        { directory: join(root, 'reports'), pattern: 'result-?.json' },
      ];
      for (const { directory } of patterns) mkdirSync(directory);

      const found = await inventory(root);
      let visits = 0;
      const candidates = new Proxy(found.candidates, {
        get(target, key, receiver) {
          if (key !== Symbol.iterator) return Reflect.get(target, key, receiver);
          return function* () {
            for (const candidate of target) {
              visits++;
              yield candidate;
            }
          };
        },
      });
      const preview = () => collectWorkGarbage({ ...found, candidates }, { mode: 'dry_run' }, context());
      const withoutPatterns = await preview();
      const withoutPatternsVisits = visits;
      expect(withoutPatternsVisits).toBeGreaterThan(0);
      expect(withoutPatterns).toMatchObject({
        observed_count: 8, would_delete_count: 8, retained: { protected: 0 }, first_global_protection: null,
      });

      baseline(root, JSON.stringify(patterns));
      visits = 0;
      expect(await preview()).toEqual(withoutPatterns);
      expect(visits).toBe(withoutPatternsVisits);
    });

    async function globOnlyRetention(
      root: string, selected: string, controls: readonly string[], directory: string, pattern: string,
    ) {
      const paths = [selected, ...controls];
      const unmarked = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
      expect(unmarked).toMatchObject({
        observed_count: paths.length, would_delete_count: paths.length,
        retained: { protected: 0 }, first_global_protection: null,
      });
      baseline(root, JSON.stringify({ directory, pattern }));
      await parity(root, paths, [selected]);
    }

    it('retains a match when only the lexical scope overlaps an alias-spelled inventory', async () => {
      const root = fs.realpathSync(fixture()), alias = `${root}-alias`;
      symlinkSync(root, alias, 'dir');
      roots.push(alias);
      const selected = work(alias, 'cards/project/tmp/gc05-scope/gc05-picked-card.dat');
      const control = work(alias, 'cards/project/tmp/gc05-scope/gc05-other-card.dat');
      const lexicalWork = join(alias, '.saivage/work'), directory = dirname(selected);
      const resolved = fs.realpathSync(directory);
      expect((await inventory(alias)).projectRoot).toBe(alias);
      expect(relative(lexicalWork, directory)).toBe(join('cards', 'project', 'tmp', 'gc05-scope'));
      expect(resolved).toBe(join(root, '.saivage/work/cards/project/tmp/gc05-scope'));
      expect(relative(lexicalWork, resolved).split(sep)[0]).toBe('..');
      expect(relative(resolved, lexicalWork).split(sep)[0]).toBe('..');
      await globOnlyRetention(alias, selected, [control], directory, 'gc05-picked-*.dat');
    });

    it('retains a match when a fixed prefix under an outside directory resolves into work', async () => {
      const root = fs.realpathSync(fixture()), w = join(root, '.saivage/work');
      const selected = work(root, 'tmp/stash/gc05-scope/gc05-picked-stash.dat');
      const sibling = work(root, 'tmp/stash/gc05-scope/gc05-other-stash.dat');
      const card = work(root, 'cards/project/tmp/gc05-picked-card.dat');
      const directory = join(root, 'gc05-outside'), prefix = join(directory, 'inward');
      mkdirSync(directory);
      symlinkSync(dirname(selected), prefix, 'dir');
      expect(relative(w, prefix).split(sep)[0]).toBe('..');
      expect(relative(prefix, w).split(sep)[0]).toBe('..');
      expect(fs.realpathSync(prefix)).toBe(dirname(selected));
      await globOnlyRetention(root, selected, [sibling, card], directory, 'inward/gc05-picked-*.dat');
    });

    it.each([
      { scope: 'ancestor', directory: '.saivage', owner: 'cards/project/tmp', otherOwner: 'tmp/stash' },
      { scope: 'work root', directory: '.saivage/work', owner: 'tmp/stash', otherOwner: 'cards/project/tmp' },
    ])('retains a match below the $scope scope', async ({ directory, owner, otherOwner }) => {
      const root = fs.realpathSync(fixture());
      const selected = work(root, `${owner}/gc05-picked-file.dat`);
      const sibling = work(root, `${owner}/gc05-other-file.dat`);
      const other = work(root, `${otherOwner}/gc05-other-file.dat`);
      await globOnlyRetention(root, selected, [sibling, other], join(root, directory), '**/gc05-picked-*.dat');
    });
  });

  const selections = ['call', 'receipt', 'both'] as const;
  const searchCarriers = ['whole locator', 'dot prefix', 'alias prefix', 'trailing separator', 'bad percent', 'filtered grep'] as const;
  it.each(searchCarriers.flatMap(carrier => selections.map(keep => ({ carrier, keep }))))
  ('uses bound $carrier search with $keep independently', async ({ carrier, keep }) => {
    const root = fixture(), run = boundWorkspace(root);
    const search = 'tmp:///project/search';
    const literal = work(root, 'cards/project/public/case?.ts');
    const wildcardSibling = work(root, 'cards/project/public/caseX.ts');
    const note = work(root, 'cards/project/tmp/search/note.md');
    const other = work(root, 'cards/project/tmp/search/other.bin');
    const outside = work(root, 'cards/project/tmp/outside.md');
    const candidates = [literal, wildcardSibling, note, other, outside];
    let selected: string[] = [];
    let args: object = { directory: search, pattern: './*.md' };
    let tool = 'glob';
    switch (carrier) {
      case 'whole locator':
        args = { directory: search, pattern: publicUrl('case?.ts') };
        selected = [literal];
        break;
      case 'dot prefix':
        selected = [note];
        break;
      case 'alias prefix': {
        const actual = work(root, 'cards/project/tmp/actual/note.md');
        candidates.push(actual, work(root, 'cards/project/tmp/actual/other.bin'));
        symlinkSync(dirname(actual), join(dirname(note), 'link'), 'dir');
        selected = [actual];
        args = { directory: search, pattern: 'link/*.md' };
        break;
      }
      case 'trailing separator':
        args = { directory: `${search}/`, pattern: './*.md' };
        selected = [note];
        break;
      case 'bad percent':
        args = { directory: 'tmp:///project/bad%ZZ', pattern: './*.md' };
        break;
      case 'filtered grep':
        tool = 'grep';
        args = { path: search, include: '*.md', pattern: 'absent-sentinel' };
        selected = [note, other];
        break;
    }
    const settled = await run(tool, args, keep);
    if (carrier === 'trailing separator' || carrier === 'bad percent') {
      expect(settled.providerResult).toMatchObject({ success: false, error: expect.any(String) });
      expect(settled.settledResultBytes).toContain(carrier === 'bad percent' ? 'bad%ZZ' : `${search}/`);
    } else expect(settled.providerResult).toMatchObject({ success: true, data: { matches: { items: [] } } });
    await parity(root, candidates, keep === 'receipt' ? [] : selected);
  });

  it.each([50, 51].flatMap(count => selections.map(keep => ({ count, keep }))))
  ('counts $count distinct nested files independently of the bound display match ($keep)', async ({ count, keep }) => {
    const root = fixture();
    const top = work(root, 'cards/project/tmp/search/report0.md');
    const nested = Array.from({ length: count }, (_, index) =>
      work(root, `cards/project/tmp/search/z/search/report${index}.md`));
    const outside = work(root, 'cards/project/tmp/else/z/search/report0.md');
    const other = work(root, 'cards/project/tmp/search/z/search/other.bin');
    const result = await boundWorkspace(root)('glob', {
      directory: 'tmp:///project/search', pattern: '**/search/report*.md', max_results: 1,
    }, keep);
    expect(result.providerResult).toMatchObject({ success: true,
      data: { matches: { items: ['.saivage/work/cards/project/tmp/search/report0.md'] } } });
    await parity(root, [top, ...nested, outside, other], [
      ...(keep === 'call' ? [] : [top]),
      ...(count === 50 && keep !== 'receipt' ? nested : []),
    ]);
  });

  it.each(['grep', 'glob', 'substitution matcher', 'percent matcher'] as const)
  ('takes literal owned $s search slots without re-lexing', async kind => {
    const root = fixture();
    const file = work(root, 'cards/project/tmp/search/explicit.bin');
    const name = kind === 'percent matcher' ? '%3F.md' : '${name}.md';
    const named = work(root, `cards/project/tmp/search/${name}`);
    const nonmatch = work(root, 'cards/project/tmp/search/?.md');
    const location = 'tmp:///project/search';
    const invoke = boundWorkspace(root);
    if (kind === 'grep') await invoke('grep', { path: `${location}/explicit.bin`, pattern: 'missing', include: '*.md' }, 'call');
    else await invoke('glob', kind === 'glob'
      ? { directory: `${location}/explicit.bin`, pattern: '*.md' }
      : { directory: location, pattern: name }, 'call');
    await parity(root, [file, named, nonmatch], [kind === 'grep' || kind === 'glob' ? file : named]);
  });

  it.each(['glob', 'grep'] as const)('treats real record %s paths as logical, not fallback scopes', async tool => {
    for (const keep of selections) {
      const root = fixture(), invoke = boundWorkspace(root);
      const preview = work(root, 'cards/project/tmp/preview-evidence');
      const control = work(root, 'cards/project/tmp/control.md');
      const statusBody = 'tmp:///example/sample tmp:///project/preview-evidence';
      new CardService(root).acceptRecord('project', 'status.md', statusBody, { kind: 'agent', agent: 'planner' });
      // Separate the retained record body from the received preview witness.
      const result = await invoke(tool, tool === 'glob'
        ? { directory: 'record:///project', pattern: '*' }
        : { path: 'record:///project', pattern: 'tmp:///example/.*' }, keep);
      expect(result.providerResult).toMatchObject({ success: true, data: { matches: { items:
        tool === 'glob' ? expect.arrayContaining(['record:///status.md?card=project'])
          : [expect.objectContaining({ path: 'record:///status.md?card=project', preview: statusBody })],
      } } });
      new CardService(root).acceptRecord('project', 'status.md', 'Updated current assessment.', { kind: 'agent', agent: 'planner' });
      await parity(root, [preview, control], tool === 'grep' && keep !== 'call' ? [preview] : []);
    }
  });

  it.each(['glob', 'grep'] as const)('preserves complete native %s displays with literal punctuation', async tool => {
    for (const keep of selections) {
      const root = fixture();
      const scope = 'cards/project/tmp/search';
      const selected = work(root, `${scope}/\${name}?/report.md`, 'needle');
      const other = work(root, `${scope}/\${name}?/other.bin`);
      const outside = work(root, 'cards/project/tmp/outside');
      const result = await boundWorkspace(root)(tool, tool === 'glob'
        ? { directory: 'tmp:///project/search', pattern: '${name}?/*.md' }
        : { path: 'tmp:///project/search/%24%7Bname%7D%3F/report.md', pattern: 'needle' }, keep);
      expect(result.providerResult).toMatchObject({ success: true, data: { matches: { items:
        tool === 'glob' ? [`.saivage/work/${scope}/\${name}?/report.md`]
          : [{ path: `.saivage/work/${scope}/\${name}?/report.md`, preview: 'needle' }],
      } } });
      await parity(root, [selected, other, outside], [selected]);
    }
  });

  it.each(selections)('preserves bound native write and Webfetch copies without using card bases (%s)', async keep => {
    for (const tool of ['write', 'webfetch'] as const) {
      const root = fixture(), invoke = boundWorkspace(root);
      const path = 'reports/case${name}.ts';
      const selected = work(root, `cards/project/public/${path}`);
      const wrongBase = work(root, `cards/project/tmp/${path}`);
      const wildcardSibling = work(root, 'cards/project/public/reports/caseAnamets');
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fixture'));
      const result = await invoke(tool, tool === 'write' ? { path, content: 'fixture' }
        : { url: 'https://93.184.216.34', save_as: path }, keep);
      fetch.mockRestore();
      const tag = { destination_kind: 'project_relative', target: path };
      expect(result.providerResult).toMatchObject({ success: true, data: tool === 'write' ? tag
        : { saved_as: path, write: { kind: 'workspace_file', data: tag } } });
      rmSync(join(root, 'reports'), { recursive: true });
      symlinkSync(dirname(selected), join(root, 'reports'), 'dir');
      await parity(root, [selected, wrongBase, wildcardSibling], [selected]);
    }
  });

  it.each(['read', 'edit'] as const)('consumes the bound %s address and independent read content', async tool => {
    for (const keep of selections) {
      const root = fixture();
      const name = 'case?#%${name}.ts', path = publicUrl(name);
      const selected = work(root, `cards/project/public/${name}`, 'tmp:///project/independent.txt');
      const independent = work(root, 'cards/project/tmp/independent.txt');
      const control = work(root, 'cards/project/public/caseX.ts');
      const settled = await boundWorkspace(root)(tool, tool === 'read' ? { path }
        : { path, old_string: 'tmp:///project/independent.txt', new_string: 'edited' }, keep);
      expect(settled.providerResult).toMatchObject({ success: true, data: { path } });
      utimesSync(selected, 1, 1);
      await parity(root, [selected, independent, control], tool === 'read' && keep !== 'call' ||
        tool === 'edit' && keep !== 'receipt' ? [selected, independent] : [selected]);
    }
  });

  it('uses only complete items from the real packer, not JSON byte slices', async () => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/search/file.md');
    const control = work(root, 'cards/project/tmp/control');
    const result = await boundWorkspace(root)('glob', { directory: 'tmp:///project/search', pattern: '*',
      position: { item_index: 0, item_byte_offset: 1 }, response_bytes: 512 }, 'receipt');
    expect(result.providerResult).toMatchObject({ success: true,
      data: { matches: { items: [expect.objectContaining({ content_hex: expect.any(String), offset_bytes: 1 })] } } });
    await parity(root, [selected, control], []);
  });

  it.each(['fold', 'redact'] as const)('uses received %s display bytes without reconstructing originals', async change => {
    for (const keep of selections) {
      const root = fixture();
      const scope = 'cards/project/tmp/search';
      const originalName = change === 'fold' ? 'deep\\report.md' : 'tok_example_fixture.md';
      const displayName = change === 'fold' ? 'deep/report.md' : 'tok-[REDACTED]';
      const original = work(root, `${scope}/${originalName}`);
      const displayed = work(root, `${scope}/${displayName}`);
      const control = work(root, `${scope}/control.bin`);
      const result = await boundWorkspace(root)('glob', { directory: 'tmp:///project/search',
        pattern: change === 'fold' ? '**/report.md' : 'tok_*.md',
      }, keep);
      const expected = `.saivage/work/${scope}/${displayName}`;
      expect(result.providerResult).toMatchObject({ success: true, data: { matches: {
        items: change === 'fold' ? [expected, expected] : [expected],
      } } });
      expect(result.settledResultBytes).not.toContain(JSON.stringify(originalName).slice(1, -1));
      await parity(root, [original, displayed, control], [
        ...(keep === 'receipt' ? [] : [original]),
        ...(change === 'fold' || keep !== 'call' ? [displayed] : []),
      ]);
    }
  });

  it.each(['glob', 'grep'] as const)('compares admitted %s locators with normalized native lookalikes', async tool => {
    for (const spelling of ['admitted', 'native', 'unresolved native'] as const) {
      const root = fixture();
      const name = 'case?.ts', path = publicUrl(name);
      const selected = work(root, `cards/project/public/${name}`, 'needle');
      const control = work(root, 'cards/project/tmp/control');
      const directory = spelling === 'admitted' ? publicUrl() : '.';
      if (directory === '.') writeFileSync(join(root, path.replaceAll('/', '\\')), 'needle');
      const result = await boundWorkspace(root)(tool, tool === 'glob'
        ? { directory, pattern: spelling === 'admitted' ? 'case*' : path }
        : { path: directory, pattern: 'needle' }, 'receipt');
      expect(result.providerResult).toMatchObject({ success: true, data: { matches: { items:
        tool === 'glob' ? [path] : [expect.objectContaining({ path })],
      } } });
      if (spelling === 'unresolved native') {
        const realpath = fs.realpathSync;
        jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
          if (String(path) === selected) throw Object.assign(new Error('fixture alias failure'), { code: 'EACCES' });
          return (realpath as any)(path, ...args);
        }) as typeof realpath);
      }
      // The known lexical file remains marked even if optional metadata cannot bound an alias.
      await parity(root, [selected, control], [selected]);
    }
  });

  it.each(['write', 'webfetch'] as const)('does not project file addresses from bound logical %s saves', async tool => {
    const root = fixture(), path = 'record:///status.md?card=project';
    const control = work(root, 'cards/project/tmp/status.md');
    const result = tool === 'write'
      ? await boundWorkspace(root)(tool, { path, content: 'record fixture' }, 'both')
      : await (async () => {
        const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('record fixture'));
        try { return await boundWorkspace(root)(tool, { url: 'https://93.184.216.34', save_as: path }, 'both'); }
        finally { fetch.mockRestore(); }
      })();
    expect(result.providerResult).toMatchObject({ success: true, data: tool === 'write'
      ? { current_url: path } : { saved_as: path, write: { kind: 'record', data: { current_url: path } } } });
    await parity(root, [control], []);
  });

  it('keeps both content and lexical/decoded scope bases bounded without probing nonreferences', async () => {
    const root = fixture();
    const names = ['bare.md', 'quote.md', 'naked.asm', 'report.md', 'cwd/keep', 'cwd/nonmatch',
      'nested/query', 'tree/inside', 'quoted dir/keep', 'head.md', 'else/head.md', 'tail.ts',
      'do-not-expand/inside', 'search/note.md', 'search/other.bin', 'scope-only/inside'];
    const files = names.map(name => work(root, `cards/project/tmp/${name}`));
    const exact = work(root, 'cards/project/public/literal?.md');
    const rootAlias = join(root, 'alias-card-root');
    symlinkSync(join(root, '.saivage/work/cards/project'), rootAlias, 'dir');
    const query = new URL('https://example.invalid/.saivage/work/cards/project/tmp/quote.md');
    query.searchParams.set('keep', publicUrl('literal?.md'));
    const realpath = fs.realpathSync, probes: string[] = [];
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      probes.push(String(path));
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    baseline(root, JSON.stringify([
      "bare.md 'quote.md' *.asm \"*.asm\" `${choice}?`",
      'https://example.invalid/.saivage/work/cards/project/tmp/bare.md',
      '[tmp:///project/bare.md](https://example.invalid/naked.asm)',
      'Ignore ${base}/tail.ts and $(echo ./do-not-expand)/inside.',
      'Keep ./report.md, ./tree and "quoted dir/keep".',
      { env: { CONFIG: 'bare.md' } },
      { cwd: { literal: 'tmp:///project/cwd' }, nested: { source_path: 'keep' } },
      { directory: 'tmp:///project/search/', pattern: './*.md' },
      { directory: { literal: 'tmp:///project/scope-only' } },
      { cwd: { literal: 'tmp:///project/scope-only' } },
      'directory="tmp:///project/scope-only"',
      `work:///cards/project ${rootAlias}`,
      { url: `${query.href}&another=${encodeURIComponent('tmp:///project/nested/query')}`,
        pattern: './head.md' },
    ]));
    await parity(root, [...files, exact], [...[3, 4, 6, 7, 8, 9, 13].map(index => files[index]!), exact]);
    expect(probes.some(path => /(?:bare\.md|quote\.md|naked\.asm|tail\.ts|do-not-expand|scope-only)/u.test(path))).toBe(false);
  });

  it.each(['node', 'after-commit'] as const)('uses compiled %s project cwd and action-relative env, with no script source', async kind => {
    const root = fixture();
    const cwd = join(root, 'jobs/${name}');
    mkdirSync(cwd, { recursive: true });
    const env = work(root, 'cards/project/tmp/env/report.md');
    symlinkSync(env, join(cwd, 'report.md'));
    const arg = work(root, 'cards/project/tmp/nested/inside.asm');
    const scriptOnly = work(root, 'cards/project/tmp/script-only.md');
    const artifact = work(root, 'cards/project/tmp/selected.bin');
    const control = work(root, 'cards/project/tmp/outside/inside.asm');
    const operation = TEST_WORKFLOWS.operations.get('shell.run')!;
    const config = operation.config.parse({ cwd: 'jobs/${name}', env: { CONFIG: 'report.md' },
      script: 'echo tmp:///project/script-only.md', artifacts: ['.saivage/work/cards/project/tmp/selected.bin'] });
    const execution = { kind: 'action' as const, operation, config,
      inputs: { args: { literal: ['tmp:///project/nested/%2A.asm'] } } };
    const wf = TEST_WORKFLOWS.cardTypes.get('project')!;
    const states = new Map(wf.states);
    if (kind === 'node') {
      const [key, state] = [...states].find(([, state]) => state.kind === 'node')!;
      if (state.kind !== 'node') throw new Error('Expected a compiled node fixture.');
      states.set(`${key}-gc-action`, { ...state, purpose: 'product', execution });
    }
    const workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes).set('project', {
      ...wf, states, ...(kind === 'after-commit' ? { afterActivationCommit: { statuses: ['done'] as const, execution } } : {}),
    }) };
    await parity(root, [env, arg, scriptOnly, artifact, control], [env, arg, artifact], { workflows });
  });

  it('marks only explicit content process cwd, including punctuation, not shell or admin roots', async () => {
    const root = fixture();
    const inside = work(root, 'cards/project/tmp/jobs/${name}/inside');
    const elsewhere = work(root, 'cards/project/tmp/jobs/elsewhere/control');
    const shell = work(root, 'cards/project/tmp/shell');
    const path = 'jobs/${name}';
    mkdirSync(join(root, 'jobs'), { recursive: true });
    symlinkSync(dirname(inside), join(root, path), 'dir');
    const command = 'echo tmp:///project/shell';
    const session = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const file = cardConversationVersionFile(root, 'project', 'planner', session.entry.filename);
    // GC projects each current call without needing a successful process or a result join.
    const rows = [undefined, '.', '.saivage/work/cards/project', path].map(cwd =>
      toolExchange('run_command', '{"success":true}', JSON.stringify({ command, cwd }))[0]);
    appendFileSync(file, JSON.stringify({ version: 13, type: 'conversation-segment', rows }) + '\n');
    await parity(root, [inside, elsewhere, shell], [inside]);
  });

  it.each([0, 50, 51])('bounds compiled legacy argv scoped globs to %i matches without losing exact selections', async count => {
    const root = fixture();
    const path = (tail: string) => work(root, `cards/project/tmp/${tail}`);
    const matches = Array.from({ length: count }, (_, index) => path(`nested/match${index}.asm`));
    const independent = path('nested/inside?exact');
    const subtree = path('nested/subtree.d/child.bin');
    const nonmatch = path('nested/insideXexact');
    const outside = path('elsewhere/match0.asm');
    const operation = TEST_WORKFLOWS.operations.get('shell.run')!;
    const execution = { kind: 'action' as const, operation, config: operation.config.parse({
      script: 'echo fixture', cwd: 'action-cwd',
    }), inputs: { args: { literal: ['tmp:///project/nested/match%2A.asm', 'tmp:///project/nested/*.d'] } } };
    const wf = TEST_WORKFLOWS.cardTypes.get('project')!;
    const workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes)
      .set('project', { ...wf, afterActivationCommit: { statuses: ['done'], execution } }) };
    baseline(root, JSON.stringify({ path: 'tmp:///project/nested/inside%3Fexact',
      pattern: 'tmp:///project/%24%7Bscope%7D/ignorable*.md' }));
    await expect(collectWorkGarbage(await inventory(root), { mode: 'dry_run' },
      context({ operationalDependencies: ['tmp:///project/%24%7Bscope%7D/ignorable*.md'] })))
      .rejects.toBeInstanceOf(WorkGcReferenceScopeError);
    await parity(root, [...matches, independent, subtree, nonmatch, outside],
      [independent, subtree, ...(count === 50 ? matches : [])], { workflows });
  });

  it.each(['write', 'webfetch'] as const)('uses same-row executed tagged %s receipts, including after an advisory display', async tool => {
    for (const selection of ['receipt', 'metadata failure', 'display failure', 'both failure'] as const) {
      const root = fixture(), invoke = boundWorkspace(root);
      const path = publicUrl('case?#%3F${name}*.ts');
      const selected = work(root, 'cards/project/public/case?#%3F${name}*.ts', 'fixture');
      const sibling = work(root, 'cards/project/public/caseX#%3F${name}Y.ts');
      const control = work(root, 'cards/project/tmp/unselected');
      if (selection === 'display failure' || selection === 'both failure') {
        const search = await invoke('glob', { directory: path, pattern: '*' },
          selection === 'both failure' ? 'both' : 'receipt');
        expect(search.providerResult).toMatchObject({ success: true,
          data: { matches: { items: expect.arrayContaining([path]) } } });
      }
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fixture'));
      const result = await invoke(tool, tool === 'write' ? { path, content: 'fixture' }
        : { url: 'https://93.184.216.34', save_as: path },
        selection === 'display failure' ? undefined : selection === 'both failure' ? 'both' : 'receipt');
      fetch.mockRestore();
      const tag = { destination_kind: 'cardwork_url', target: path };
      expect(result.providerResult).toMatchObject({ success: true, data: tool === 'write' ? tag
        : { saved_as: path, write: { kind: 'workspace_file', data: tag } } });
      if ('row' in result && result.row) {
        expect(result.row).toMatchObject({ tool, kind: 'tool_result', context_policy: { settlement_origin: 'executed' } });
        expect(JSON.parse(result.row.content)).toEqual(result.providerResult);
      }
      utimesSync(selected, 1, 1);
      if (selection === 'receipt') {
        await parity(root, [selected, sibling, control], [selected]);
        continue;
      }
      const realpath = fs.realpathSync;
      const probe = jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
        if (String(path) === selected) throw Object.assign(new Error('fixture metadata sentry'), { code: 'EACCES', syscall: 'realpath' });
        return (realpath as any)(path, ...args);
      }) as typeof realpath);
      if (selection === 'display failure') await parity(root, [selected, sibling, control], [selected]);
      else for (const mode of ['dry_run', 'delete'] as const) {
        await expect(collectWorkGarbage(await inventory(root), { mode }, context()))
          .rejects.toBeInstanceOf(WorkGcReferenceScopeError);
        expect([selected, sibling, control].every(existsSync)).toBe(true);
      }
      probe.mockRestore();
    }
  });

  it.each([0, 1, 50, 51])('counts %i actual scoped entries, including empty directories, before publishing any glob marks', async count => {
    const root = fixture(), scope = join(root, '.saivage/work/cards/project/tmp/search');
    const files: string[] = [], kept: string[] = [];
    for (let i = 0; i < count; i++) {
      if (i % 2 === 0) {
        const path = work(root, `cards/project/tmp/search/match-${i}.asm`);
        files.push(path); kept.push(path);
      } else {
        const directory = join(scope, `match-${i}.asm`);
        mkdirSync(directory, { recursive: true });
        if (i === 1) {
          const path = work(root, `cards/project/tmp/search/match-${i}.asm/child.bin`);
          files.push(path); kept.push(path);
        }
      }
    }
    files.push(...['other.asm.txt', 'Match-case.asm', 'unrelated.bin'].map(name =>
      work(root, `cards/project/tmp/search/${name}`)));
    // Matching sibling entries do not contribute to this glob's cutoff.
    for (let i = 0; i < 55; i++) files.push(work(root, `cards/project/tmp/searchish/match-${i}.asm`));
    baseline(root, JSON.stringify({ directory: 'tmp:///project/search', pattern: 'match-*.asm' }));
    await parity(root, files, count <= 50 ? kept : []);
    expect(existsSync(scope)).toBe(true);
    if (count > 1) expect(existsSync(join(scope, 'match-1.asm'))).toBe(true);
  });

  it('counts a matching directory once while protecting more than fifty nonmatching descendants', async () => {
    const root = fixture(), files: string[] = [];
    for (let i = 0; i < 60; i++) files.push(work(root, `cards/project/tmp/evidence.asm/child-${i}.bin`));
    const control = work(root, 'cards/project/tmp/control');
    baseline(root, JSON.stringify({ directory: 'tmp:///project', pattern: '*.asm' }));
    await parity(root, [...files, control], files);
  });

  it.each([
    ['*', 50], ['*', 51], ['**/*', 50], ['**/*', 51],
  ] as const)('excludes the concrete scope itself from %s matching and the %i-child cutoff', async (pattern, count) => {
    const root = fixture();
    const files = Array.from({ length: count }, (_, i) =>
      work(root, `cards/project/tmp/concrete-scope/child-${i}.asm`));
    const control = work(root, 'cards/project/tmp/concrete-scopeish/control.asm');
    baseline(root, JSON.stringify({ directory: 'tmp:///project/concrete-scope', pattern }));
    await parity(root, [...files, control], count === 50 ? files : []);
    expect(existsSync(join(root, '.saivage/work/cards/project/tmp/concrete-scope'))).toBe(true);
  });

  it.each(['card', 'global'] as const)('uses %s fallback bases and deduplicates overlapping scopes before the cutoff', async source => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/one.asm');
    const control = work(root, 'cards/project/tmp/other.bin');
    const nested = work(root, 'cards/project/tmp/nested/one.asm');
    if (source === 'card') appendConversationBatch({ projectRoot: root }, [message('Keep "./*.asm"')]);
    else {
      const { buildGlobalAgentIngressRows } = await import('../../src/runtime/actors/conversation-session.js');
      const session = 'agent:analyst:global' as const, entryId = randomUUID();
      const rows = buildGlobalAgentIngressRows(session, randomUUID(), 'Fixture boundary',
        { kind: 'unavailable', reason: 'not_recorded' });
      appendConversationBatch({ projectRoot: root }, rows);
      publishCompactedConversationSegment({ projectRoot: root }, session, {
        identity: { genesisId: randomUUID(), entryId, segmentVersion: 2, timestamp: new Date().toISOString(),
          filename: versionFilename(2, entryId) },
        history: { summaryText: 'Keep "./*.asm"', protectedPrompts: [],
          requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
        cutoffSourceIndex: 1, cutoffMessageId: rows[1].id, continuation: { kind: 'between_rounds' },
      });
    }
    await parity(root, [selected, control, nested], source === 'card' ? [selected] : []);
  });

  it('counts fifty physical entries once across overlapping card fallback bases', async () => {
    const root = fixture(), files = Array.from({ length: 50 }, (_, i) =>
      work(root, `cards/project/tmp/formation-${i}.asm`));
    baseline(root, 'Keep "**/*formation*.asm"');
    await parity(root, files, files);
  });

  it('isolates two linked cards and keeps independently paired same-line assignment groups separate', async () => {
    const root = fixture(), child = new CardService(root).create({ type: 'code', parent: 'project',
      title: 'scope child', bootstrap_content: 'scope brief', created_by: 'analyst', depends_on: [] });
    const a = work(root, 'cards/project/tmp/search/one.asm');
    const b = work(root, `cards/${child.id}/tmp/search/one.asm`);
    const other = work(root, 'cards/project/tmp/other/two.txt');
    const control = work(root, 'cards/project/tmp/other/control.asm');
    baseline(root, 'directory="tmp:///project/search", pattern="*.asm"; pattern=`*.txt`, directory=`tmp:///project/other`');
    await parity(root, [a, b, other, control], [a, other]);
  });

  it('decodes JSON assignment escapes and URI wildcard punctuation before matching, not native percent punctuation', async () => {
    const root = fixture();
    const a = work(root, 'cards/project/tmp/quote" dir/item1.asm');
    const b = work(root, 'cards/project/tmp/percent%20/item2.asm');
    const control = work(root, 'cards/project/tmp/percent /item3.asm');
    baseline(root, [
      `directory=${JSON.stringify(dirname(a))}, pattern="item?.asm"`,
      `Keep "${join(root, '.saivage/work/cards/project/tmp/percent%20')}/*.asm"`,
      'Keep "tmp:///project/quote%22%20dir/item%3F.asm"',
    ].join('\n'));
    await parity(root, [a, b, control], [a, b]);
  });

  it('bases glob counting on all observed entries, not age, byte filters or other protections', async () => {
    const root = fixture(), files = Array.from({ length: 51 }, (_, i) =>
      work(root, `cards/project/tmp/entry-${i}.asm`, i === 49 ? 'abc' : 'abcd', i === 50 ? 3000 : 1000));
    baseline(root, JSON.stringify({ directory: 'tmp:///project', pattern: 'entry-*.asm' }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context({
      operationalInputs: { path: files[0] },
    }));
    expect(result).toMatchObject({ retained: { protected: 1, recent: 1 }, would_delete_count: 49,
      first_global_protection: null });
    const limited = await collectWorkGarbage(await inventory(root), {
      mode: 'dry_run', targetBytes: 200, minFileBytes: 4,
    }, context());
    expect(limited).toMatchObject({ observed_count: 51, observed_logical_bytes: 203, would_delete_count: 1,
      retained: { protected: 0, below_min_file_bytes: 1, target: 49 } });
  });

  it.each(['pm global', 'tool arguments', 'nested JSON', 'inherited JSON', 'reverse single', 'backtick', 'cwd', 'nested override',
    'standalone quoted', 'standalone bare'] as const)('extracts %s as one scoped glob through canonical semantic projection', async kind => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/search dir/deep/formation-one.asm');
    const selectedRoot = work(root, 'cards/project/tmp/search dir/formation-root.asm');
    const controls = ['cards/project/tmp/search dir/other.asm', 'cards/project/tmp/search dir/formation.txt',
      'cards/project/tmp/search dirish/formation-other.asm'].map(name => work(root, name));
    const directory = 'tmp:///project/search%20dir', pattern = '**/*formation*.asm';
    const structured = { directory, pattern };
    let prose = '';
    if (kind === 'pm global') {
      const { buildGlobalAgentIngressRows } = await import('../../src/runtime/actors/conversation-session.js');
      // Preserve the reported directory and pattern spellings, but constrain the fixture tree.
      appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows('agent:analyst:global', randomUUID(),
        'directory="work:///cards", pattern="**/*formation*.asm"', { kind: 'unavailable', reason: 'not_recorded' }));
      // This third matching file is in the reported scope too.
      await parity(root, [selected, selectedRoot, ...controls], [selected, selectedRoot, controls[2]!]);
      return;
    }
    if (kind === 'tool arguments') appendConversationBatch({ projectRoot: root },
      [toolExchange('glob', JSON.stringify({ success: true }), JSON.stringify(structured))[0]!]);
    if (kind === 'nested JSON') prose = `Evidence: ${JSON.stringify(JSON.stringify(structured))}`;
    if (kind === 'inherited JSON') prose = JSON.stringify({ directory, nested: JSON.stringify({ pattern }) });
    if (kind === 'reverse single') prose = `pattern='${pattern}', directory='${directory}'`;
    if (kind === 'backtick') prose = `directory=\`${directory}\`, pattern=\`${pattern}\``;
    if (kind === 'cwd') prose = JSON.stringify({ cwd: directory, pattern });
    if (kind === 'nested override') prose = JSON.stringify({ directory: 'tmp:///project/search dirish',
      nested: { cwd: directory, query: { pattern } } });
    if (kind === 'standalone quoted') prose = `Keep "${directory}/${pattern}"`;
    if (kind === 'standalone bare') prose = `Keep ${directory}/${pattern}.`;
    if (prose) appendConversationBatch({ projectRoot: root }, [message(prose)]);
    await parity(root, [selected, selectedRoot, ...controls], [selected, selectedRoot]);
  });

  it.each(['work', 'tmp', 'project', 'system', 'file', 'native', 'alias', 'missing', 'outside'] as const)(
    'resolves %s scopes by metadata only without scanning outside work', async spelling => {
      const root = fixture(), path = work(root, 'cards/project/tmp/percent% dir/one.asm');
      const control = work(root, 'cards/project/tmp/percent% dirish/two.asm');
      const scope = dirname(path);
      symlinkSync(scope, join(root, 'alias'));
      mkdirSync(join(root, 'outside'));
      const scopes = {
        work: 'work:///cards/project/tmp/percent%25%20dir',
        tmp: 'tmp:///project/percent%25%20dir',
        project: 'project:///.saivage/work/cards/project/tmp/percent%25%20dir',
        system: `system:///${scope.slice(1).replace('%', '%25').replace(' ', '%20')}`,
        file: `file://${scope.replace('%', '%25').replace(' ', '%20')}`,
        native: scope, alias: 'project:///alias', missing: 'tmp:///project/missing',
        outside: 'project:///outside',
      };
      baseline(root, JSON.stringify({ directory: scopes[spelling], pattern: '*.asm' }));
      const open = fs.opendirSync, enumerated: string[] = [];
      jest.spyOn(fs, 'opendirSync').mockImplementation(((path: any, ...args: any[]) => {
        enumerated.push(String(path)); return (open as any)(path, ...args);
      }) as typeof open);
      await parity(root, [path, control], spelling === 'missing' || spelling === 'outside' ? [] : [path]);
      expect(enumerated.every(path => path.startsWith(join(root, '.saivage/work')) ||
        path === cardRecordsRoot(root, 'project'))).toBe(true);
    });

  it('discards a broad glob independently of exact, small-glob, operational and process protection', async () => {
    const root = fixture(), files = Array.from({ length: 51 }, (_, i) =>
      work(root, `cards/project/tmp/search/formation-${i}.asm`));
    const directoryChild = work(root, 'cards/project/tmp/search/formation-dir.asm/inside');
    const small = work(root, 'cards/project/tmp/search/small.txt');
    const capture = work(root, 'processes/active/stdout.log');
    baseline(root, [
      'directory="tmp:///project/search", pattern="**/*formation*.asm"',
      'Keep "tmp:///project/search/formation-0.asm"',
      'Keep tmp:///project/search/formation-dir.asm',
      'Keep "tmp:///project/search/small*.txt"',
    ].join('\n'));
    await parity(root, [...files, directoryChild, small, capture], [files[0]!, files[1]!, directoryChild, small, capture], {
      operationalInputs: { source_path: files[1] },
      protection: { retainAll: false, capturePaths: [capture] },
    });
  });

  it.each(['quoted', 'bare', 'paired', 'operational'] as const)(
    'does not re-extract protective fragments from one over-limit %s glob', async kind => {
      const root = fixture();
      const files = Array.from({ length: 51 }, (_, i) =>
        work(root, `cards/project/tmp/search/sub-${i}/formation-${i}.asm`));
      const pattern = 'tmp:///project/search/**/*formation*.asm';
      let input: unknown = {};
      if (kind === 'operational') input = { directory: 'tmp:///project/search', pattern: '**/*formation*.asm' };
      else baseline(root, kind === 'quoted' ? `Keep "${pattern}"`
        : kind === 'bare' ? `Keep ${pattern}.`
          : 'directory="tmp:///project/search", pattern="**/*formation*.asm"');
      await parity(root, files, [], { operationalInputs: input });
    });

  it('keeps literal bracket/brace punctuation and exact structured wildcard filenames distinct from inference', async () => {
    const root = fixture();
    const names = ['item[1]{x}.asm', 'item1x.asm', 'native?.txt', 'nativeZ.txt', 'one.asm', 'two.ASM'];
    const files = names.map(name => work(root, `cards/project/tmp/${name}`));
    baseline(root, JSON.stringify({ directory: 'tmp:///project', pattern: '*[1]{x}.asm',
      source_path: files[2], prose: 'Keep "tmp:///project/o?e.asm"' }));
    // Native punctuation in an exact field is not wildcard syntax, even without URI encoding.
    await parity(root, files, [files[0]!, files[2]!, files[4]!], {
      operationalInputs: { source_path: files[2] },
    });
  });

  it.each(['ambiguous', 'newline', 'separate', 'assignment newline'] as const)(
    'does not guess scope for %s assignment groups', async kind => {
    const root = fixture();
    const files = ['left/formation.asm', 'right/formation.asm', 'control'].map(name =>
      work(root, `cards/project/tmp/${name}`));
    baseline(root, kind === 'ambiguous'
      ? 'directory="tmp:///project/left", directory="tmp:///project/right", pattern="**/*formation*.asm"'
      : kind === 'newline' ? 'directory="tmp:///project/missing",\npattern="**/*formation*.asm"'
        : kind === 'assignment newline' ? 'directory=\n"tmp:///project/missing", pattern="**/*formation*.asm"'
          : 'directory="tmp:///project/missing"; pattern="**/*formation*.asm"');
    await parity(root, files, files.slice(0, 2));
  });

  it('uses directory for the pattern and cwd independently for exact structured paths', async () => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/search/one.asm');
    const exact = work(root, 'cards/project/tmp/cwd/exact.txt');
    const control = work(root, 'cards/project/tmp/search/exact.txt');
    baseline(root, JSON.stringify({ directory: 'tmp:///project/search', cwd: 'tmp:///project/cwd',
      pattern: '*.asm', source_path: 'exact.txt' }));
    await parity(root, [selected, exact, control], [selected, exact]);
  });

  it('omits owned shell scripts but keeps literal action args and non-shell executable argv', async () => {
    const root = fixture(), files = ['script-output.txt', 'noextension', 'one.asm', 'control'].map(name =>
      work(root, `cards/project/tmp/${name}`));
    const wf = TEST_WORKFLOWS.cardTypes.get('project')!;
    const operation = TEST_WORKFLOWS.operations.get('shell.run')!;
    const execution = { kind: 'action' as const, operation,
      config: operation.config.parse({ script: 'cat tmp:///project/script-output.txt', cwd: 'jobs/${name}' }),
      inputs: { args: { literal: ['tmp:///project/*.asm'] } } };
    const workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes)
      .set('project', { ...wf, afterActivationCommit: { statuses: ['done'], execution } }) };
    await parity(root, files, files.slice(1, 3), { workflows, operationalInputs: {
      mcp: { command: files[1],
        args: ['tmp:///project/noextension'] },
    } });
  });

  it.each(['broken', 'malformed', 'substitution'] as const)('drops %s suggested glob scope but refuses operational scope uncertainty', async kind => {
    const root = fixture();
    const control = work(root, 'cards/project/tmp/control.asm');
    symlinkSync(join(root, 'missing'), join(root, 'broken'));
    const inputs = { directory: kind === 'broken' ? 'project:///broken'
      : kind === 'malformed' ? 'work:///%ZZ' : '${UNKNOWN}', pattern: '*.asm' };
    baseline(root, JSON.stringify(inputs));
    for (const mode of ['dry_run', 'delete'] as const)
      await expect(collectWorkGarbage(await inventory(root), { mode }, context({ operationalInputs: inputs })))
        .rejects.toBeInstanceOf(WorkGcReferenceScopeError);
    await parity(root, [control], []);
  });

  it('skips reserved directories before matching, metadata access and threshold counting', async () => {
    const root = fixture(), selected = work(root, 'cards/project/tmp/one.asm');
    const reservedRoot = join(root, '.saivage/work/cards/project/tmp/hidden.saivage-tmp');
    mkdirSync(reservedRoot);
    for (let i = 0; i < 55; i++) writeFileSync(join(reservedRoot, `match-${i}.asm`), 'hidden');
    baseline(root, JSON.stringify({ directory: 'tmp:///project', pattern: '**/*.asm' }));
    const stat = fs.lstatSync, open = fs.opendirSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((path: any, ...args: any[]) => {
      expect(String(path)).not.toContain('hidden.saivage-tmp'); return (stat as any)(path, ...args);
    }) as typeof stat);
    jest.spyOn(fs, 'opendirSync').mockImplementation(((path: any, ...args: any[]) => {
      expect(String(path)).not.toContain('hidden.saivage-tmp'); return (open as any)(path, ...args);
    }) as typeof open);
    await parity(root, [selected], [selected]);
    expect(readFileSync(join(reservedRoot, 'match-0.asm'), 'utf8')).toBe('hidden');
  });

  it('yields to cancellation during a large nonmatching observed-entry pass before selection', async () => {
    const root = fixture();
    for (let i = 0; i < 1600; i++) work(root, `cards/project/tmp/entry-${i}.bin`);
    const found = await inventory(root), controller = new AbortController();
    let entered = false, checks = 0, armed = false;
    const operationalInputs = { get pattern() { entered = true; return '*.no-match'; } };
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context({ operationalInputs,
      assertCollecting: () => {
        controller.signal.throwIfAborted();
        if (entered) {
          checks++;
          if (checks === 300 && !armed) {
            armed = true;
            void setImmediate().then(() => controller.abort(new Error('glob matching cancelled')));
          }
        }
      },
    }))).rejects.toThrow('glob matching cancelled');
    expect(checks).toBeGreaterThanOrEqual(300);
    expect(existsSync(join(root, '.saivage/work/cards/project/tmp/entry-1599.bin'))).toBe(true);
  });

  it.each(['operational_input', 'process_owner', 'process_capture'] as const)(
    'attributes the first sufficient global mark to %s without leaking input', async source => {
      const root = fixture(), sentinel = 'PRIVATE-attribution-sentinel';
      const candidate = work(root, `cards/project/tmp/${sentinel}`);
      const snapshots: unknown[] = [];
      const { createWorkGcProgress } = await import('../../src/application/work-gc-progress.js');
      let time = 0;
      const progress = createWorkGcProgress(value => snapshots.push(value), () => time += 1001);
      const overrides = {
        operationalInputs: source === 'operational_input' ? { root, config: sentinel } : {},
        protection: { retainAll: source === 'process_owner', capturePaths: source === 'process_capture' ? [join(root, 'capture')] : [] },
      };
      const found = await inventory(root);
      const plain = await collectWorkGarbage(found, { mode: 'dry_run' }, context(overrides));
      const observed = await collectWorkGarbage(found, { mode: 'dry_run' }, context({ ...overrides, progress }));
      const brokenObserver = createWorkGcProgress(() => { throw new Error('PRIVATE observer failure'); });
      expect(await collectWorkGarbage(found, { mode: 'dry_run' }, context({ ...overrides, progress: brokenObserver }))).toEqual(plain);
      const mark = { reason: source === 'process_owner' ? 'process_owner_uncertain'
        : 'operational_root', source };
      expect(observed).toEqual(plain);
      expect(observed).toMatchObject({ first_global_protection: mark, retained: { protected: 1 }, would_delete_count: 0 });
      expect(snapshots).toContainEqual(expect.objectContaining({ first_global_protection: mark, phase: 'selection' }));
      expect(JSON.stringify({ observed, snapshots })).not.toContain(sentinel);
      expect(existsSync(candidate)).toBe(true);
    });

  it('can protect every candidate individually with no global mark', async () => {
    const root = fixture();
    work(root, 'cards/project/tmp/selected.txt');
    appendConversationBatch({ projectRoot: root }, [message('Keep tmp:///project/selected.txt')]);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(result).toMatchObject({ first_global_protection: null, retained: { protected: 1 }, would_delete_count: 0 });
  });

  it('attributes configured global conversation payloads at their canonical semantic callback', async () => {
    const root = fixture();
    work(root, 'cards/project/tmp/control');
    const { buildGlobalAgentIngressRows } = await import('../../src/runtime/actors/conversation-session.js');
    symlinkSync(join(root, 'missing'), join(root, 'unknown-alias'));
    appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows('agent:analyst:global', randomUUID(), 'Keep project:///unknown-alias', { kind: 'unavailable', reason: 'not_recorded' }));
    expect(await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context())).toMatchObject({
      first_global_protection: null,
      retained: { protected: 0 }, would_delete_count: 1,
    });
  });

  it('stops reference extraction after its first global mark before later metadata', async () => {
    const root = fixture();
    work(root, 'cards/project/tmp/control');
    const reference = join(root, 'later-reference');
    symlinkSync(join(root, 'missing'), join(root, 'unknown-alias'));
    baseline(root, JSON.stringify({ source_path: join(root, 'unknown-alias'), later: { source_path: reference } }));
    const realpath = fs.realpathSync, failure = new Error('unexpected later metadata');
    const marks: unknown[] = [];
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path) === reference) throw failure;
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    const progress = { phase() {}, increment() {}, update(value: unknown) { marks.push(value); } };
    await expect(collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context({ progress, operationalPaths: [root] })))
      .resolves.toMatchObject({ retained: { protected: 1 }, would_delete_count: 0 });
    expect(marks.filter(value => 'first_global_protection' in (value as object)))
      .toEqual([{ first_global_protection: { reason: 'operational_root', source: 'operational_input' } }]);
  });

  it('stops metadata resolution immediately after the lexical path itself marks all work', async () => {
    const root = fixture();
    work(root, 'cards/project/tmp/control');
    const found = await inventory(root);
    const realpath = jest.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('Metadata after lexical whole-work protection');
    });
    expect(await collectWorkGarbage(found, { mode: 'dry_run' },
      context({ operationalInputs: { path: root } }))).toMatchObject({
      first_global_protection: { reason: 'operational_root', source: 'operational_input' },
      retained: { protected: 1 }, would_delete_count: 0,
    });
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each(['matching_first', 'nonmatching_first'] as const)(
    'deduplicates absolute workflow globs and alias scopes without merging relative inputs (%s)', async order => {
    const root = fixture(), cards = new CardService(root);
    const children = [0, 1].map(index => cards.create({
      type: 'code', parent: 'project', title: `Child ${index}`, bootstrap_content: 'brief',
      created_by: 'analyst', depends_on: [],
    }));
    const selected = ['dedup-one.bin', 'dedup-two.bin'].map(name =>
      work(root, `cards/project/tmp/shared/${name}`));
    const control = work(root, 'cards/project/tmp/shared/control');
    const relative = children.map(child => work(root, `cards/${child.id}/tmp/relative-literal`));
    const alias = join(root, 'shared-alias');
    symlinkSync(dirname(control), alias);
    const workflow = TEST_WORKFLOWS.cardTypes.get('code')!;
    const execution = {
      kind: 'action' as const, operation: TEST_WORKFLOWS.operations.get('shell.run')!,
      config: { script: 'printf ok', cwd: 'gc-operation-cwd', artifacts: [], env: {} },
      inputs: { args: { literal: [`${alias}/dedup-*.bin`, 'relative-literal'] } },
    };
    const workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes)
      .set('code', { ...workflow, afterActivationCommit: { statuses: ['done'], execution } }) };
    const found = await inventory(root), realpath = fs.realpathSync, test = RegExp.prototype.test;
    const { globToRegExp } = await import('../../src/workspace/glob-matcher.js');
    const matcher = globToRegExp('dedup-*.bin'), scope = dirname(control);
    const first = order === 'matching_first' ? selected[0]! : control;
    // Reorder only metadata from the real inventory. Exercise both probe paths;
    // leave the complete entry inventory in its actual opendir order.
    const candidates = [...found.candidates].sort((a, b) =>
      Number(join(root, '.saivage/work', b.path) === first) -
      Number(join(root, '.saivage/work', a.path) === first));
    const probeInputs: string[] = [];
    for (const candidate of candidates) {
      const path = join(root, '.saivage/work', candidate.path);
      if (dirname(path) !== scope) continue;
      const input = path.slice(scope.length + 1);
      probeInputs.push(input);
      if (test.call(matcher, input)) break;
    }
    const fullMatchInputs = found.entries.filter(path => dirname(path) === scope)
      .map(path => path.slice(scope.length + 1));
    const matcherCalls = new Map<RegExp, string[]>();
    let scopeResolutions = 0;
    jest.spyOn(fs, 'realpathSync').mockImplementation(((path: any, ...args: any[]) => {
      if (String(path).replace(/\/$/u, '') === alias) scopeResolutions++;
      return (realpath as any)(path, ...args);
    }) as typeof realpath);
    jest.spyOn(RegExp.prototype, 'test').mockImplementation(function(this: RegExp, input: string) {
      if (this.source === matcher.source) {
        const calls = matcherCalls.get(this) ?? [];
        calls.push(input);
        matcherCalls.set(this, calls);
      }
      return test.call(this, input);
    });
    expect(await collectWorkGarbage({ ...found, candidates }, { mode: 'dry_run' }, context({ workflows })))
      .toMatchObject({ retained: { protected: 4 }, would_delete_count: 1 });
    expect(scopeResolutions).toBe(1);
    // Exactly one actual matcher performs the candidate prefix and one complete
    // inventory pass. Repeated cards/arguments must add neither another matcher
    // nor another pass; the probe length itself depends on candidate order.
    expect(matcherCalls.size).toBe(1);
    expect([...matcherCalls.values()]).toEqual([[...probeInputs, ...fullMatchInputs]]);
    expect([...selected, control, ...relative].every(existsSync)).toBe(true);
  });

  it('does no glob matching when its resolved scope contains only already-protected candidates', async () => {
    const root = fixture();
    const scope = dirname(work(root, 'cards/project/tmp/covered/ignored-one.bin'));
    work(root, 'cards/project/tmp/outside');
    const { globToRegExp } = await import('../../src/workspace/glob-matcher.js');
    const pattern = globToRegExp('ignored-*.bin').source, test = RegExp.prototype.test;
    let globChecks = 0;
    jest.spyOn(RegExp.prototype, 'test').mockImplementation(function(this: RegExp, input: string) {
      if (this.source === pattern) globChecks++;
      return test.call(this, input);
    });
    expect(await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context({
      operationalInputs: [{ path: scope }, { directory: scope, pattern: 'ignored-*.bin' }],
    }))).toMatchObject({ retained: { protected: 1 }, would_delete_count: 1 });
    expect(globChecks).toBe(0);
  });

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

  it.each(['work:///%ZZ', 'tmp:///not-a-card/', 'work:///cards/project/tmp?unknown'])('ignores malformed recognized content URI %s', async reference => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    baseline(root, JSON.stringify({ path: reference }));
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context());
    expect(result).toMatchObject({ deleted_count: 1, retained: { protected: 0 } });
    expect(existsSync(candidate)).toBe(false);
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
    expect((await collectWorkGarbage(await inventory(root), { mode: 'delete' }, context())).deleted_count).toBe(2);
    expect([selected, garbage].some(existsSync)).toBe(false);
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
      await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context(overrides)))
        .resolves.toMatchObject({ retained: { protected: 1 }, deleted_count: 0 });
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
              identity: { genesisId: randomUUID(), entryId, segmentVersion: segment.entry.version + 1,
                timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(segment.entry.version + 1, entryId) },
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
    expect(segmentReads).toBe(sessions);
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
      prose: '`./quoted space.txt`', nested: JSON.stringify({ endpoint: `https://example.invalid/?path=${encodeURIComponent('tmp:///project/context/query.txt')}` }) }));
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
    expect(resolutions).toBeLessThanOrEqual(oldResolutions);
    expect(current.retained.protected).toBe(selected.length);
    const sources: unknown[] = [];
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, captureReferences(sources));
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
      retained: { protected: 3, recent: 1 }, first_global_protection: null });
    expect(files.map(path => readFileSync(path))).toEqual(bytes);
  });

  it('protects mixed quoted record paths without retaining the Markdown label locator', async () => {
    const root = fixture();
    const inline = work(root, 'cards/project/tmp/inline 🚲 code.txt');
    const quoted = work(root, 'cards/project/tmp/double quoted.txt');
    const destination = work(root, 'cards/project/tmp/Markdown destination.txt');
    const tail = work(root, 'cards/project/tmp/single quoted tail.txt');
    const decoy = work(root, 'cards/project/tmp/label-only.txt');
    const control = work(root, 'cards/project/tmp/control.txt');
    baseline(root, [
      `🚀 Keep \`${inline}\`${JSON.stringify(quoted)}`,
      `Use [label tmp:///project/label-only.txt only](<${destination}>) and then '${tail}'.`,
    ].join('\n'));
    await parity(root, [inline, quoted, destination, tail, decoy, control],
      [inline, quoted, destination, tail]);
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

  it.each(['fallback', 'scoped'] as const)('matches quoted %s wildcards without prefix or global protection', async scope => {
    const root = fixture();
    const selected = work(root, 'cards/project/tmp/evidence/inside.txt');
    const control = work(root, 'cards/project/tmp/control');
    baseline(root, scope === 'fallback' ? 'Keep "**/*.txt"' : `Keep "${dirname(selected)}/*.txt"`);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: 2000 }, context());
    expect(result).toMatchObject({ retained: { protected: 1 },
      first_global_protection: null, would_delete_count: 1, deleted_count: 0 });
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
      "Keep './relative-basename.txt'",
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

  it.each(['realpath', 'fallback lstat'] as const)('refuses required %s ENAMETOOLONG without candidate effects', async operation => {
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
    for (const mode of ['dry_run', 'delete'] as const) {
      const error = await collectWorkGarbage(found, { mode }, context({ operationalPaths: [reference] })).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(WorkGcReferenceScopeError);
      const response = workGcFailureResponse({ mode }, error, 'collection_failed', false, 'not_resumed');
      expect(response).toMatchObject({ disposition: 'refused', reason: 'reference_scope_unresolved', result: null, failure: { code: 'ENAMETOOLONG' } });
      expect(JSON.stringify(response)).not.toContain('recognized-reference');
    }
    expect(observed).toContain('realpath');
    expect(observed.includes('lstat')).toBe(operation === 'fallback lstat');
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(candidate)).toEqual(bytes);
  });

  it('discards an unbounded synthetic backtick path without depending on host limits', async () => {
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
    expect(result).toMatchObject({ retained: { protected: 0 }, would_delete_count: 1, deleted_count: 0 });
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
    const { protectedPrompts } = selectConversationProtection({ inherited: [], rows: [row], sourceVersion: 2, cutoffCount: 1 });
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 3, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(3, entryId) },
      history: { summaryText: 'Prior task: tmp:///project/effective-summary.txt', protectedPrompts: [...protectedPrompts], requiredModelFacts: facts },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    const current = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const sources: unknown[] = [];
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, captureReferences(sources));
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
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } })))
      .resolves.toMatchObject({ deleted_count: 0 });
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
    compactWorkGcCard(root, fresh.workflows, 'project', new Date(Date.now() + 1000).toISOString());
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
    const operational = workGcOperationalInputs(fresh.config);
    expect(operational.operationalInputs.git).toEqual({ source_roots: ['.'] });
    const unlinked = join(root, '.saivage/cards/card-z/records'); mkdirSync(unlinked, { recursive: true });
    writeFileSync(join(unlinked, 'executions.jsonl'), 'malformed unlinked evidence\n');
    const ref = readCard(root, 'project')!.git!.branch_ref, oid = fixtureGit(root, 'rev-parse', ref);
    const gitIndex = readFileSync(join(root, '.git/index'));
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', before: Date.now() + 1000 },
      context({ workflows: fresh.workflows, ...operational }));
    expect(preview.first_global_protection).toBeNull();
    expect(preview.would_delete_count).toBe(1 + captures.length);
    const result = await collectWorkGarbage(await inventory(root), { mode: 'delete', before: Date.now() + 1000 },
      context({ workflows: fresh.workflows, ...operational }));
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
    await inspectWorkGcCanonicalState(root, TEST_WORKFLOWS, () => {}, captureReferences(values));
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

  it('previews and freshly deletes files at or above a floor across card and global work', async () => {
    const root = fixture();
    const small = work(root, 'cards/project/tmp/small', '123');
    const equal = work(root, 'cards/project/tmp/equal', '1234');
    const large = work(root, 'tmp/stash/large', '12345');
    const protectedPath = work(root, 'cards/project/tmp/needed', '123456');
    baseline(root, 'Keep tmp:///project/needed');
    const paths = [small, equal, large, protectedPath];
    const bytes = paths.map(path => readFileSync(path));
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', minFileBytes: 4 }, context());
    expect(preview).toMatchObject({ observed_count: 4, observed_logical_bytes: 18,
      would_delete_count: 2, would_delete_logical_bytes: 9, deleted_count: 0,
      retained: { protected: 1, recent: 0, stale: 0, opaque: 0, target: 0, below_min_file_bytes: 1 },
      expected_accounted_logical_bytes_remaining: 9, accounted_target_shortfall: null });
    expect(paths.map(path => readFileSync(path))).toEqual(bytes);
    const deletion = await collectWorkGarbage(await inventory(root), { mode: 'delete', minFileBytes: 4 }, context());
    expect(deletion).toEqual({ ...preview, mode: 'delete', deleted_count: 2, deleted_logical_bytes: 9,
      would_delete_count: 0, would_delete_logical_bytes: 0 });
    expect(readFileSync(small)).toEqual(bytes[0]);
    expect(readFileSync(protectedPath)).toEqual(bytes[3]);
    expect([equal, large].map(existsSync)).toEqual([false, false]);
  });

  it('zero admits empty files but still reports a supplied floor, unlike omission', async () => {
    const root = fixture(), empty = work(root, 'tmp/stash/empty', '');
    const unfiltered = await collectWorkGarbage(await inventory(root), { mode: 'dry_run' }, context());
    expect(unfiltered.retained).not.toHaveProperty('below_min_file_bytes');
    expect(unfiltered).toMatchObject({ observed_count: 1, observed_logical_bytes: 0,
      would_delete_count: 1, would_delete_logical_bytes: 0 });
    const zero = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', minFileBytes: 0 }, context());
    expect(zero).toEqual({ ...unfiltered, retained: { ...unfiltered.retained, below_min_file_bytes: 0 } });
    expect(existsSync(empty)).toBe(true);
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete', minFileBytes: 0 }, context()))
      .resolves.toMatchObject({ deleted_count: 1, deleted_logical_bytes: 0, retained: { below_min_file_bytes: 0 } });
    expect(existsSync(empty)).toBe(false);
  });

  it.each([
    { targetBytes: 16, remaining: 16, shortfall: 0, selected: 1, bytes: 4 },
    { targetBytes: 0, remaining: 7, shortfall: 7, selected: 3, bytes: 13 },
  ])('applies mtime then path order and all filters for target $targetBytes', async ({ targetBytes, remaining, shortfall, selected, bytes }) => {
    const root = fixture();
    const later = work(root, 'tmp/stash/a-later', '1234', 1500);
    const first = work(root, 'tmp/stash/b-first', '1234', 1000);
    const tied = work(root, 'tmp/stash/c-tied', '12345', 1000);
    const small = work(root, 'tmp/stash/z-small', '123', 1500);
    const cutoffEqual = work(root, 'tmp/stash/d-cutoff-equal', '1234', 2000);
    const filters = { before: 2000, targetBytes, minFileBytes: 4 };
    const preview = await collectWorkGarbage(await inventory(root), { mode: 'dry_run', ...filters }, context());
    expect(preview).toMatchObject({ observed_count: 5, observed_logical_bytes: 20,
      would_delete_count: selected, would_delete_logical_bytes: bytes,
      retained: { protected: 0, recent: 1, stale: 0, opaque: 0, target: 3 - selected, below_min_file_bytes: 1 },
      expected_accounted_logical_bytes_remaining: remaining, accounted_target_shortfall: shortfall });
    expect([later, first, tied, small, cutoffEqual].every(existsSync)).toBe(true);
    const deletion = await collectWorkGarbage(await inventory(root), { mode: 'delete', ...filters }, context());
    expect(deletion).toEqual({ ...preview, mode: 'delete', deleted_count: selected, deleted_logical_bytes: bytes,
      would_delete_count: 0, would_delete_logical_bytes: 0 });
    expect([later, first, tied, small, cutoffEqual].map(existsSync))
      .toEqual([selected === 1, false, selected === 1, true, true]);
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
    const shrunk = work(root, 'cards/project/tmp/shrunk');
    const replaced = work(root, 'cards/project/tmp/replaced');
    const vanished = work(root, 'cards/project/tmp/vanished');
    const alias = work(root, 'cards/project/tmp/alias');
    const found = await inventory(root);
    appendFileSync(changed, 'new');
    writeFileSync(shrunk, 'abc');
    utimesSync(shrunk, 1, 1);
    renameSync(replaced, `${replaced}.old`);
    writeFileSync(replaced, 'abcd');
    utimesSync(replaced, 1, 1);
    unlinkSync(vanished);
    unlinkSync(alias); symlinkSync(changed, alias);
    const fresh = work(root, 'cards/project/tmp/fresh');
    const result = await collectWorkGarbage(found, { mode: 'delete', minFileBytes: 4 }, context());
    expect(result.deleted_count).toBe(0);
    expect(result.retained).toMatchObject({ stale: 5, below_min_file_bytes: 0 });
    expect(readFileSync(shrunk, 'utf8')).toBe('abc');
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
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context())).rejects.toThrow(/torn conversation/);
    await expect(collectWorkGarbage(found, { mode: 'dry_run', minFileBytes: Number.MAX_SAFE_INTEGER }, context()))
      .rejects.toThrow(/torn conversation/);
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
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 3, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(3, entryId) },
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

  it.each(['card', 'record', 'conversation'] as const)('never opens malformed historical %s during GC', async kind => {
    const root = fixture(), cards = new CardService(root);
    const candidate = work(root, 'cards/project/tmp/garbage');
    cards.editCard('project', { title: 'historical-card-marker' });
    const historicalCard = JSON.parse(readFileSync(join(root, '.saivage/cards/project/card-head.json'), 'utf8')).ordinary.entry_id;
    cards.editCard('project', { title: 'current title' });
    cards.acceptRecord('project', 'review-extra.md', 'historical-record-marker', { kind: 'agent', agent: 'analyst' });
    const historicalRecord = JSON.parse(readFileSync(cardRecordHeadFile(root, 'project', definition()), 'utf8')).accepted.entry_id;
    cards.acceptRecord('project', 'review-extra.md', 'current record', { kind: 'agent', agent: 'analyst' });
    const row = message('historical-conversation-marker');
    appendConversationBatch({ projectRoot: root }, [row]);
    const old = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, 'agent:planner:project', {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 3, timestamp: '2026-10-24T00:01:00.000Z', filename: versionFilename(3, entryId) },
      history: { summaryText: 'summary', protectedPrompts: [], requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
    const path = kind === 'conversation' ? cardConversationVersionFile(root, 'project', 'planner', old.entry.filename)
      : kind === 'card' ? join(root, '.saivage/cards/project/card-history', `${historicalCard}.json`)
      : join(cardRecordsRoot(root, 'project'), 'accepted', `${historicalRecord}.json`);
    expect(path).toBeDefined();
    writeFileSync(path, '{malformed historical}\n');
    const read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((input: any, ...args: any[]) => {
      if (String(input) === path) throw new Error('Historical GC read');
      return (read as any)(input, ...args);
    }) as typeof read);
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context()))
      .resolves.toMatchObject({ deleted_count: 1 });
    spy.mockRestore();
    expect(readFileSync(path, 'utf8')).toBe('{malformed historical}\n');
    expect(existsSync(candidate)).toBe(false);
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
    await expect(collectWorkGarbage(found, { mode: 'delete', minFileBytes: 4 }, context({ fatal })))
      .rejects.toMatchObject({ name: 'PublicationOutcomeUnknownError' });
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
    const small = work(root, 'cards/project/tmp/0-small', '123');
    const first = work(root, 'cards/project/tmp/a');
    const second = work(root, 'cards/project/tmp/b');
    const found = await inventory(root);
    const unlink = fs.unlinkSync;
    let cancelled = false;
    jest.spyOn(fs, 'unlinkSync').mockImplementation(path => { unlink(path); cancelled = true; });
    syncBuiltinESMExports();
    await expect(collectWorkGarbage(found, { mode: 'delete', minFileBytes: 4 }, context({ assertCollecting: () => {
      if (cancelled) throw new Error('cancelled');
    } }))).rejects.toMatchObject({ name: 'WorkGcInterruptedError', result: {
      observed_count: 3, observed_logical_bytes: 11, expected_accounted_logical_bytes_remaining: 7,
      deleted_count: 1, deleted_logical_bytes: 4, retained: { below_min_file_bytes: 1 },
    } });
    expect(readFileSync(small, 'utf8')).toBe('123');
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  it.each(['record', 'index', 'execution', 'segment'] as const)('skips %s consumption after whole-work protection', async kind => {
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
    const read = jest.spyOn(fs, 'readFileSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } })))
      .resolves.toMatchObject({ deleted_count: 0, retained: { protected: 1 } });
    expect(read).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(candidate)).toBe(true);
  });

  it.each(['record', 'index', 'segment'] as const)('does not consume missing %s after whole-work protection', async kind => {
    const root = fixture(), candidate = work(root, 'cards/project/tmp/control');
    appendConversationBatch({ projectRoot: root }, [message('Retained evidence')]);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    const path = kind === 'record' ? join(cardRecordsRoot(root, 'project'), 'record-brief.json')
      : kind === 'index' ? cardConversationVersionIndexFile(root, 'project', 'planner')
      : cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
    unlinkSync(path);
    const unlink = jest.spyOn(fs, 'unlinkSync');
    await expect(collectWorkGarbage(await inventory(root), { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } })))
      .resolves.toMatchObject({ deleted_count: 0, retained: { protected: 1 } });
    expect(unlink).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(candidate)).toBe(true);
  });

  it.each(['looping', 'denied'] as const)('discards a suggested %s alias despite excluding unrelated possessive prose', async kind => {
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
    expect(result).toMatchObject({ retained: { protected: 0 }, would_delete_count: 1, deleted_count: 0 });
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

  it('unknown process footprints retain all, and cancellation stops before effects for unresolved suggestions', async () => {
    const root = fixture();
    const candidate = work(root, 'cards/project/tmp/file');
    const found = await inventory(root);
    expect((await collectWorkGarbage(found, { mode: 'delete' }, context({ protection: { retainAll: true, capturePaths: [] } }))).deleted_count).toBe(0);
    symlinkSync('/missing-target', join(root, 'broken'));
    baseline(root, 'project:///broken/file');
    expect((await collectWorkGarbage(found, { mode: 'dry_run' }, context())).would_delete_count).toBe(1);
    await expect(collectWorkGarbage(found, { mode: 'delete' }, context({ assertCollecting: () => { throw new Error('cancelled'); } }))).rejects.toThrow('cancelled');
    expect(existsSync(candidate)).toBe(true);
  });
});
