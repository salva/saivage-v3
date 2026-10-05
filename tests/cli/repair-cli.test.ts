import { afterEach, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stringify } from 'yaml';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import {
  cardHeadFile,
  cardPreviousHeadFile,
  cardRecordHeadFile,
  cardAcceptedRecordFile,
  cardHistoryRoot,
  cardMailboxRoot,
  cardRecordsRoot,
  cardConversationsRoot,
  runtimeProcessLockFile,
  cardConversationVersionIndexFile,
  globalAgentConversationVersionIndexFile,
  appLogFile,
} from '../../src/persistence/layout.js';
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { validateInitialCard } from '../../src/persistence/canonical-card-artifacts.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import {
  appendConversationBatch,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import {
  acquireRuntimeLifecycleLock,
  releaseRuntimeLifecycleLock,
} from '../../src/runtime/lock.js';

const question = jest.fn<(question: string) => Promise<string>>();
const close = jest.fn();
jest.unstable_mockModule('node:readline/promises', () => ({
  createInterface: () => ({ question, close }),
}));
const { run } = await import('../../src/cli.js');
const roots: string[] = [];
const originalCwd = process.cwd();
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process, 'stdin', stdin);
  jest.restoreAllMocks();
  syncBuiltinESMExports();
  question.mockReset();
  close.mockReset();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function fixture() {
  const external = fs.mkdtempSync(join(tmpdir(), 'repair-cli-'));
  roots.push(external);
  const root = join(external, 'project');
  initProjectTree(root);
  fs.writeFileSync(join(root, '.saivage', 'saivage.yaml'), stringify(TEST_SAIVAGE_CONFIG));
  const backup = join(external, 'backup');
  fs.mkdirSync(backup);
  const report = join(external, 'report.md');
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  process.chdir(root);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const cards = new CardService(root);
  const child = cards.create({
    type: 'code',
    parent: 'project',
    title: 'first',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  return {
    root,
    backup,
    report,
    cards,
    child,
    args: (target: string) => [
      'node',
      'saivage',
      'repair',
      '--target',
      target,
      '--backup',
      backup,
      '--report',
      report,
    ],
  };
}
it('allows absolute ordinary project source-side backup and fresh report paths', async () => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  const backup = join(f.root, 'operator-backup');
  fs.mkdirSync(backup);
  const report = join(f.root, 'operator-repair-report.md');
  f.cards.editCard(f.child.id, { title: 'latest' });
  fs.unlinkSync(cardHeadFile(f.root, f.child.id));
  fs.writeFileSync(cardHeadFile(f.root, f.child.id), 'broken selector');
  question.mockImplementation(async (text) =>
    text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
  );
  await run([
    'node',
    'saivage',
    'repair',
    '--target',
    target,
    '--backup',
    backup,
    '--report',
    report,
  ]);
  expect(f.cards.read(f.child.id)!.title).toBe('first');
  expect(fs.readFileSync(report, 'utf8')).toContain('Exact repaired owner validated');
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
});
it.each(['cards', 'agents', 'logs', 'work', 'repair-attic', 'locks'] as const)(
  'refuses exact/aliased generated %s backup and report destinations before inspection',
  async (name) => {
    const f = fixture();
    const target = `card:${f.child.id}`;
    const generated = join(f.root, '.saivage', name);
    fs.mkdirSync(generated, { recursive: true });
    const alias = join(f.root, 'source-side-alias');
    fs.symlinkSync(generated, alias, 'dir');
    const before = fs.readFileSync(cardHeadFile(f.root, f.child.id));
    for (const destination of [generated, alias])
      for (const role of ['backup', 'report']) {
        const backup = role === 'backup' ? destination : f.backup;
        const report = role === 'report' ? join(destination, 'fresh-report.md') : f.report;
        await expect(
          run([
            'node',
            'saivage',
            'repair',
            '--target',
            target,
            '--backup',
            backup,
            '--report',
            report,
          ]),
        ).rejects.toThrow('outside generated/lifecycle roots');
        expect(question).not.toHaveBeenCalled();
        expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
        expect(fs.existsSync(report)).toBe(false);
      }
    expect(fs.readFileSync(cardHeadFile(f.root, f.child.id))).toEqual(before);
  },
);
it('refuses a lexically generated destination even when its root resolves to ordinary source-side storage', async () => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  const ordinary = join(f.root, 'ordinary-files');
  fs.mkdirSync(ordinary);
  fs.symlinkSync(ordinary, join(f.root, '.saivage', 'repair-attic'), 'dir');
  await expect(
    run([
      'node',
      'saivage',
      'repair',
      '--target',
      target,
      '--backup',
      join(f.root, '.saivage/repair-attic'),
      '--report',
      f.report,
    ]),
  ).rejects.toThrow('outside generated/lifecycle roots');
  expect(question).not.toHaveBeenCalled();
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
});
it('refuses a report inside the declared backup, including a resolved source-side alias', async () => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  const alias = join(f.root, 'backup-alias');
  fs.symlinkSync(f.backup, alias, 'dir');
  for (const directory of [f.backup, alias])
    await expect(
      run([
        'node',
        'saivage',
        'repair',
        '--target',
        target,
        '--backup',
        f.backup,
        '--report',
        join(directory, 'fresh-report.md'),
      ]),
    ).rejects.toThrow('outside the declared backup');
  expect(question).not.toHaveBeenCalled();
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
});
it.each(['json', 'utf8'] as const)(
  'holds exclusive bound null ownership across acknowledgement/report/consent and restores a corrupt %s card selector without scans',
  async (encoding) => {
    const f = fixture();
    f.cards.editCard(f.child.id, { title: 'second' });
    const target = `card:${f.child.id}`;
    const path = cardHeadFile(f.root, f.child.id);
    const prev = cardPreviousHeadFile(f.root, f.child.id);
    const previous = JSON.parse(fs.readFileSync(prev, 'utf8'));
    fs.unlinkSync(path);
    const corrupt = encoding === 'json' ? Buffer.from('corrupt selector') : Buffer.from([0xff]);
    fs.writeFileSync(path, corrupt);
    question.mockImplementation(async (text) => {
      const owner = JSON.parse(fs.readFileSync(runtimeProcessLockFile(f.root), 'utf8'));
      expect(owner).toMatchObject({ lock_state: 'bound', control_endpoint: null });
      if (text.includes('BACKUP COMPLETE')) {
        expect(fs.existsSync(f.report)).toBe(false);
        return `BACKUP COMPLETE ${target}`;
      }
      expect(fs.readFileSync(f.report, 'utf8')).toContain('Proposed');
      expect(fs.readFileSync(path)).toEqual(corrupt);
      return `REPAIR ${target}`;
    });
    const scan = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('scan forbidden');
    });
    syncBuiltinESMExports();
    await run(f.args(target));
    expect(scan).not.toHaveBeenCalled();
    expect(f.cards.read(f.child.id)?.title).toBe('first');
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).head_id).not.toBe(previous.head_id);
    expect(fs.readFileSync(f.report, 'utf8')).toContain('Exact repaired owner validated');
    expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
  },
);
it.each(['backup', 'consent'] as const)(
  'refused %s leaves torn conversation and selector bytes unchanged',
  async (refusal) => {
    const f = fixture();
    const session = 'agent:planner:project';
    const target = `conversation:${session}`;
    appendConversationBatch({ projectRoot: f.root }, [
      {
        id: 'text',
        session_id: session,
        role: 'user',
        kind: 'text',
        content: 'hello',
        timestamp: '2026-10-04T00:00:00.000Z',
        context_policy: TEXT_ROW_POLICY,
        round_id: `r-user-${'0'.repeat(32)}`,
        message_index: 1,
        block_index: 0,
      },
    ]);
    const segment = readCurrentConversationSegment(f.root, session)!;
    const path = join(
      f.root,
      '.saivage',
      'cards',
      'project',
      'conversations',
      'planner',
      'versions',
      segment.entry.filename,
    );
    const indexPath = cardConversationVersionIndexFile(f.root, 'project', 'planner');
    fs.appendFileSync(path, 'torn');
    const body = fs.readFileSync(path);
    const index = fs.readFileSync(indexPath);
    question.mockImplementation(async (text) =>
      text.includes('BACKUP COMPLETE') && refusal !== 'backup' ? `BACKUP COMPLETE ${target}` : 'NO',
    );
    await expect(run(f.args(target))).rejects.toThrow('Repair stopped');
    expect(fs.readFileSync(path)).toEqual(body);
    expect(fs.readFileSync(indexPath)).toEqual(index);
    expect(fs.existsSync(f.report)).toBe(refusal === 'consent');
    expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
  },
);
it('tail-only consent reports then truncates without replacing the selector', async () => {
  const f = fixture();
  const session = 'agent:planner:project';
  const target = `conversation:${session}`;
  appendConversationBatch({ projectRoot: f.root }, [
    {
      id: 'text',
      session_id: session,
      role: 'user',
      kind: 'text',
      content: 'hello',
      timestamp: '2026-10-04T00:00:00.000Z',
      context_policy: TEXT_ROW_POLICY,
      round_id: `r-user-${'0'.repeat(32)}`,
      message_index: 1,
      block_index: 0,
    },
  ]);
  const segment = readCurrentConversationSegment(f.root, session)!;
  const path = join(
    f.root,
    '.saivage',
    'cards',
    'project',
    'conversations',
    'planner',
    'versions',
    segment.entry.filename,
  );
  const indexPath = cardConversationVersionIndexFile(f.root, 'project', 'planner');
  const index = fs.readFileSync(indexPath);
  const segmentBytes = fs.readFileSync(path);
  fs.appendFileSync(path, 'torn');
  question.mockImplementation(async (text) =>
    text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
  );
  await run(f.args(target));
  expect(fs.readFileSync(path)).toEqual(segmentBytes);
  expect(fs.readFileSync(indexPath)).toEqual(index);
  expect(fs.readFileSync(f.report, 'utf8')).toContain('discard 4 unterminated suffix bytes');
});
it('rechecks inspected bytes after consent and refuses changed data', async () => {
  const f = fixture();
  f.cards.editCard(f.child.id, { title: 'second' });
  const target = `card:${f.child.id}`;
  const path = cardHeadFile(f.root, f.child.id);
  fs.unlinkSync(path);
  fs.writeFileSync(path, 'bad');
  question.mockImplementation(async (text) => {
    if (text.includes('BACKUP COMPLETE')) return `BACKUP COMPLETE ${target}`;
    fs.writeFileSync(path, 'changed');
    return `REPAIR ${target}`;
  });
  await expect(run(f.args(target))).rejects.toThrow('Repair stopped');
  expect(fs.readFileSync(path, 'utf8')).toBe('changed');
  expect(fs.readFileSync(f.report, 'utf8')).not.toContain('Completed:');
});
it.each(['selector', 'identity', 'artifact'] as const)(
  'restores previous record with exact corrupt %s move in the reported order',
  async (fault) => {
    const f = fixture();
    const target = `record:${f.child.id}/status.md`;
    const definition = {
      filename: 'status.md',
      format: 'markdown' as const,
      schema: 'work-status.v1',
      bootstrap: false,
      declared: true,
    };
    f.cards.acceptRecord(f.child.id, 'status.md', 'first', 'analyst');
    f.cards.acceptRecord(f.child.id, 'status.md', 'second', 'analyst');
    const path = cardRecordHeadFile(f.root, f.child.id, definition);
    const current = JSON.parse(fs.readFileSync(path, 'utf8'));
    const badPath =
      fault !== 'artifact'
        ? path
        : cardAcceptedRecordFile(f.root, f.child.id, current.accepted.entry_id);
    if (fault !== 'artifact') fs.unlinkSync(path);
    fs.writeFileSync(
      badPath,
      fault === 'identity'
        ? JSON.stringify({ ...current, record_name: 'other.md' })
        : 'bad selected data',
    );
    question.mockImplementation(async (text) =>
      text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
    );
    await run(f.args(target));
    const restored = f.cards.readRecordCurrent(f.child.id, 'status.md');
    expect(restored).toMatchObject({
      kind: 'found',
      value: { projection: { accepted: { content: 'first' } } },
    });
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).head_id).not.toBe(current.head_id);
    const report = fs.readFileSync(f.report, 'utf8');
    const completed = report.split('\n').filter((line) => line.startsWith('Completed:'));
    expect(completed[fault !== 'artifact' ? 0 : 1]).toContain('Move exact corrupt');
    expect(completed[fault !== 'artifact' ? 1 : 0]).toContain('Fresh-publish');
  },
);
it('refuses existing owner and invalid or unattended options before prompts/effects', async () => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  const lock = acquireRuntimeLifecycleLock({ projectRoot: f.root, mode: 'bound' });
  try {
    await expect(run(f.args(target))).rejects.toThrow();
    expect(question).not.toHaveBeenCalled();
  } finally {
    releaseRuntimeLifecycleLock(lock);
  }
  fs.writeFileSync(runtimeProcessLockFile(f.root), 'malformed');
  await expect(run(f.args(target))).rejects.toThrow();
  expect(question).not.toHaveBeenCalled();
  fs.unlinkSync(runtimeProcessLockFile(f.root));
  await expect(run([...f.args(target), '--yes'])).rejects.toThrow();
  await expect(run(f.args('card:invalid'))).rejects.toThrow();
  Object.defineProperty(process, 'stdin', { configurable: true, value: new PassThrough() });
  await expect(run(f.args(target))).rejects.toThrow('interactive');
  expect(fs.existsSync(f.report)).toBe(false);
});
it('refuses positively dead and indeterminate pre-existing locks without removal or prompts', async () => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  const path = runtimeProcessLockFile(f.root);
  const lock = acquireRuntimeLifecycleLock({ projectRoot: f.root, mode: 'bound' });
  const record = JSON.parse(fs.readFileSync(path, 'utf8'));
  const denial = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  try {
    const before = fs.readFileSync(path);
    await expect(run(f.args(target))).rejects.toThrow();
    expect(fs.readFileSync(path)).toEqual(before);
    expect(question).not.toHaveBeenCalled();
  } finally {
    denial.mockRestore();
    releaseRuntimeLifecycleLock(lock);
  }
  fs.writeFileSync(path, JSON.stringify({ ...record, pid: 99999999, process_start_identity: '0' }));
  const dead = fs.readFileSync(path);
  await expect(run(f.args(target))).rejects.toThrow();
  expect(fs.readFileSync(path)).toEqual(dead);
  expect(question).not.toHaveBeenCalled();
});
it('requires an existing external backup before inspection or lifecycle ownership', async () => {
  const f = fixture();
  fs.rmSync(f.backup, { recursive: true });
  const head = fs.readFileSync(cardHeadFile(f.root, f.child.id));
  await expect(run(f.args(`card:${f.child.id}`))).rejects.toThrow();
  expect(question).not.toHaveBeenCalled();
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
  expect(fs.readFileSync(cardHeadFile(f.root, f.child.id))).toEqual(head);
});
it.each(['unreachable', 'missing-prev', 'same-selected-damage'] as const)(
  'refuses %s without searching immutable files or publishing a candidate',
  async (fault) => {
    const f = fixture();
    const id = fault === 'unreachable' ? 'card-z' : f.child.id;
    const target = `card:${id}`;
    question.mockImplementation(async (text) =>
      text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
    );
    if (fault === 'missing-prev') {
      fs.unlinkSync(cardHeadFile(f.root, id));
      fs.writeFileSync(cardHeadFile(f.root, id), 'bad');
    }
    if (fault === 'same-selected-damage') {
      f.cards.enqueueNotification(id, {
        id: '11111111-1111-4111-8111-111111111111',
        content: 'queue-only',
        created_at: new Date().toISOString(),
      });
      const head = JSON.parse(fs.readFileSync(cardHeadFile(f.root, id), 'utf8'));
      fs.writeFileSync(
        join(
          f.root,
          '.saivage/cards/project/children/a/card-history',
          `${head.ordinary.entry_id}.json`,
        ),
        'bad artifact',
      );
    }
    const path = cardHeadFile(f.root, f.child.id);
    const before = fs.readFileSync(path);
    await expect(run(f.args(target))).rejects.toThrow('Repair stopped');
    expect(fs.readFileSync(path)).toEqual(before);
    expect(fs.existsSync(f.report)).toBe(false);
    expect(question).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
  },
);
function breakSelections(root: string, id: string) {
  for (const path of [cardHeadFile(root, id), cardPreviousHeadFile(root, id)]) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    fs.writeFileSync(path, 'unusable selector');
  }
}
it.each([
  'missing-first-body',
  'complete-malformed',
  'complete-malformed-with-tail',
  'broken-prev-index',
] as const)('refuses conversation %s without empty synthesis or prefix salvage', async (fault) => {
  const f = fixture();
  const session = 'agent:planner:project' as const;
  const target = `conversation:${session}`;
  appendConversationBatch({ projectRoot: f.root }, [
    {
      id: 'text',
      session_id: session,
      role: 'user',
      kind: 'text',
      content: 'hello',
      timestamp: '2026-10-04T00:00:00.000Z',
      context_policy: TEXT_ROW_POLICY,
      round_id: `r-user-${'0'.repeat(32)}`,
      message_index: 1,
      block_index: 0,
    },
  ]);
  const segment = readCurrentConversationSegment(f.root, session)!;
  const path = join(
    f.root,
    '.saivage/cards/project/conversations/planner/versions',
    segment.entry.filename,
  );
  const index = cardConversationVersionIndexFile(f.root, 'project', 'planner');
  if (fault === 'missing-first-body') fs.unlinkSync(path);
  else if (fault === 'broken-prev-index') {
    fs.unlinkSync(index);
    fs.writeFileSync(index, 'broken');
    fs.writeFileSync(
      join(f.root, '.saivage/cards/project/conversations/planner/index.prev.json'),
      'broken previous',
    );
  } else
    fs.writeFileSync(
      path,
      `{complete malformed}\n${fault === 'complete-malformed-with-tail' ? 'torn' : ''}`,
    );
  const before = fs.existsSync(path) ? fs.readFileSync(path) : null;
  const selector = fs.readFileSync(index);
  question.mockImplementation(async (text) =>
    text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
  );
  await expect(run(f.args(target))).rejects.toThrow('Repair stopped');
  expect(fs.readFileSync(index)).toEqual(selector);
  if (before !== null) expect(fs.readFileSync(path)).toEqual(before);
  else expect(fs.existsSync(path)).toBe(false);
  expect(fs.existsSync(f.report)).toBe(false);
  expect(question).toHaveBeenCalledTimes(1);
});
function consentDiscard(target: string) {
  question.mockImplementation(async (text) =>
    text.includes('BACKUP COMPLETE')
      ? `BACKUP COMPLETE ${target}`
      : text.includes('DISCARD CARD')
        ? `DISCARD CARD ${target}`
        : `REPAIR ${target}`,
  );
}
it('discards only six exact own roots with no inventory, preserves children/siblings/parent/globals/source/logs, and publishes strict synthetic loss records and sessions', async () => {
  const f = fixture();
  const goal = f.cards.create({
    type: 'goal',
    parent: 'project',
    title: 'lost goal',
    bootstrap_content: 'lost requirements',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  const descendant = f.cards.create({
    type: 'code',
    parent: goal.id,
    title: 'unlinked child',
    bootstrap_content: 'child brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  initializeAndValidateCurrentGeneratedState(f.root, TEST_WORKFLOWS);
  appendAppLogEntry(f.root, 'event', () => ({
    type: 'event',
    data: {
      kind: 'runtime_diagnostic',
      id: 'retained-log',
      timestamp: '2026-10-04T00:00:00.000Z',
      error_message: 'preserved diagnostic',
    },
  }));
  fs.writeFileSync(join(f.root, 'source.md'), 'retained source');
  const preserved = [
    cardHeadFile(f.root, 'project'),
    cardHeadFile(f.root, f.child.id),
    cardHeadFile(f.root, descendant.id),
    globalAgentConversationVersionIndexFile(f.root, 'analyst'),
    appLogFile(f.root),
    join(f.root, 'source.md'),
    join(f.root, '.saivage', 'saivage.yaml'),
  ].map((path) => ({ path, bytes: fs.readFileSync(path) }));
  breakSelections(f.root, goal.id);
  const own = [
    cardHeadFile(f.root, goal.id),
    cardPreviousHeadFile(f.root, goal.id),
    cardHistoryRoot(f.root, goal.id),
    cardMailboxRoot(f.root, goal.id),
    cardRecordsRoot(f.root, goal.id),
    cardConversationsRoot(f.root, goal.id),
  ];
  const target = `card:${goal.id}`;
  consentDiscard(target);
  const scan = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
    throw new Error('discard inventory forbidden');
  });
  const originalRename = fs.renameSync;
  const moves: string[] = [];
  const openDirectory = jest.spyOn(fs, 'opendirSync').mockImplementation(() => {
    throw new Error('discard inventory forbidden');
  });
  const originalRead = fs.readFileSync;
  const forbiddenReads: string[] = [];
  const ownedRead = jest.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
    const path = String(args[0]);
    if (
      path.includes('/repair-attic/') ||
      path.startsWith(cardHeadFile(f.root, descendant.id).replace('/card-head.json', '/')) ||
      path.startsWith(cardHeadFile(f.root, f.child.id).replace('/card-head.json', '/'))
    ) {
      forbiddenReads.push(path);
      throw new Error('unrelated own-root content inspection forbidden');
    }
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync);
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (own.includes(String(from))) moves.push(String(from));
    originalRename(from, to);
  });
  syncBuiltinESMExports();
  jest.resetModules();
  jest.unstable_mockModule('node:fs', () => ({ ...fs }));
  const { run: instrumentedRun } = await import('../../src/cli.js');
  scan.mockClear();
  await instrumentedRun([...f.args(target), '--discard-card', '--card-type', 'goal']);
  expect(scan).not.toHaveBeenCalled();
  expect(openDirectory).not.toHaveBeenCalled();
  expect(forbiddenReads).toEqual([]);
  expect(moves).toEqual(own);
  ownedRead.mockRestore();
  syncBuiltinESMExports();
  for (const row of preserved) expect(fs.readFileSync(row.path)).toEqual(row.bytes);
  expect(f.cards.read(goal.id)).toMatchObject({
    created_by: 'runtime:repair',
    version_seq: 1,
    title: `Recovered card ${goal.id} — data discarded`,
    child_membership: [],
    active_child_order: [],
    depends_on: [],
    pending_notifications: [],
    lifecycle: {
      status: 'failed',
      result: { kind: 'runtime-failure' },
      error: expect.any(String),
      completed_at: expect.any(String),
    },
  });
  const synthetic = f.cards.read(goal.id)!;
  expect(() =>
    validateInitialCard({ ...synthetic, title: 'invented original title' }, 'repair test'),
  ).toThrow(/synthetic/);
  expect(() =>
    validateInitialCard(
      {
        ...synthetic,
        lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
      },
      'repair test',
    ),
  ).toThrow(/synthetic/);
  expect(() => validateInitialCard({ ...synthetic, priority: 1 }, 'repair test')).toThrow(
    /synthetic/,
  );
  expect(f.cards.read(descendant.id)).toBeNull();
  expect(fs.existsSync(cardHeadFile(f.root, descendant.id))).toBe(true);
  for (const name of ['brief.md', 'status.md'])
    expect(f.cards.readRecordCurrent(goal.id, name)).toMatchObject({
      kind: 'found',
      value: {
        projection: {
          state: 'closed',
          draft: null,
          accepted: {
            writer_agent: 'runtime:repair',
            card_version_seq: 1,
            card_history: { version: 1 },
            content: expect.stringContaining('placeholder requirements'),
          },
        },
      },
    });
  for (const name of ['planner', 'reviewer'])
    expect(readCurrentConversationSegment(f.root, `agent:${name}:${goal.id}`)).toBeNull();
  expect(() => initializeAndValidateCurrentGeneratedState(f.root, TEST_WORKFLOWS)).not.toThrow();
  const report = fs.readFileSync(f.report, 'utf8');
  expect(report).toContain('UNKNOWN count/content');
  expect(report).toContain('later explicit ancestor Run');
  expect(question).toHaveBeenCalledTimes(3);
  // The existing status operation remains available; exact active-parent authority is exercised in the next E2E slice.
  expect(f.cards.setStatus(goal.id, 'changed').lifecycle.status).toBe('changed');
});
it.each([
  'missing-type',
  'unknown-type',
  'incompatible-type',
  'previous-usable',
  'healthy-record-damage',
  'refused-destructive',
] as const)('refuses discard %s without canonical effects', async (fault) => {
  const f = fixture();
  const target = `card:${f.child.id}`;
  f.cards.editCard(f.child.id, { title: 'second' });
  if (fault === 'healthy-record-damage') {
    const definition = {
      filename: 'brief.md',
      format: 'markdown' as const,
      schema: 'card-brief.v1',
      bootstrap: true,
      declared: true,
    };
    fs.writeFileSync(cardRecordHeadFile(f.root, f.child.id, definition), 'bad record');
  } else if (fault === 'previous-usable') {
    fs.unlinkSync(cardHeadFile(f.root, f.child.id));
    fs.writeFileSync(cardHeadFile(f.root, f.child.id), 'bad');
  } else breakSelections(f.root, f.child.id);
  const paths = [cardHeadFile(f.root, f.child.id), cardPreviousHeadFile(f.root, f.child.id)];
  const before = paths.map((path) => fs.readFileSync(path));
  consentDiscard(target);
  if (fault === 'refused-destructive')
    question.mockImplementation(async (text) =>
      text.includes('BACKUP COMPLETE')
        ? `BACKUP COMPLETE ${target}`
        : text.includes('DISCARD CARD')
          ? 'NO'
          : `REPAIR ${target}`,
    );
  const type =
    fault === 'unknown-type' ? 'unknown-type' : fault === 'incompatible-type' ? 'project' : 'code';
  const args = [
    ...f.args(target),
    '--discard-card',
    ...(fault === 'missing-type' ? [] : ['--card-type', type]),
  ];
  await expect(run(args)).rejects.toThrow('Repair stopped');
  paths.forEach((path, index) => expect(fs.readFileSync(path)).toEqual(before[index]));
  expect(fs.existsSync(join(f.root, '.saivage', 'repair-attic'))).toBe(false);
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
});
it('project discard leaves nested children and globals physically intact and reports the whole project consequence', async () => {
  const f = fixture();
  const childPath = cardHeadFile(f.root, f.child.id);
  const childBytes = fs.readFileSync(childPath);
  const global = globalAgentConversationVersionIndexFile(f.root, 'analyst');
  const globalBytes = fs.readFileSync(global);
  breakSelections(f.root, 'project');
  fs.rmSync(cardMailboxRoot(f.root, 'project'), { recursive: true });
  const target = 'card:project';
  consentDiscard(target);
  await run([...f.args(target), '--discard-card']);
  expect(fs.readFileSync(childPath)).toEqual(childBytes);
  expect(fs.readFileSync(global)).toEqual(globalBytes);
  expect(f.cards.read(f.child.id)).toBeNull();
  expect(fs.readFileSync(f.report, 'utf8')).toContain('PROJECT DISCARD');
  expect(fs.readFileSync(f.report, 'utf8')).toContain('Absent own root:');
  expect(() => initializeAndValidateCurrentGeneratedState(f.root, TEST_WORKFLOWS)).not.toThrow();
});
it('refuses a supplied non-leaf type at depth twelve before any discard effect', async () => {
  const f = fixture();
  let parent = 'project';
  for (let depth = 1; depth < 12; depth++)
    parent = f.cards.create({
      type: 'goal',
      parent,
      title: `level ${depth}`,
      bootstrap_content: 'brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    }).id;
  const leaf = f.cards.create({
    type: 'code',
    parent,
    title: 'level 12',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  breakSelections(f.root, leaf.id);
  const target = `card:${leaf.id}`;
  consentDiscard(target);
  const before = fs.readFileSync(cardHeadFile(f.root, leaf.id));
  await expect(run([...f.args(target), '--discard-card', '--card-type', 'goal'])).rejects.toThrow(
    'Repair stopped',
  );
  expect(fs.readFileSync(cardHeadFile(f.root, leaf.id))).toEqual(before);
  expect(fs.existsSync(join(f.root, '.saivage', 'repair-attic'))).toBe(false);
});
it('leaves unrelated dangling dependencies byte-identical and lets strict graph admission fail honestly', async () => {
  const f = fixture();
  const goal = f.cards.create({
    type: 'goal',
    parent: 'project',
    title: 'goal',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  const leaf = f.cards.create({
    type: 'code',
    parent: goal.id,
    title: 'dependency',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
  });
  const dependent = f.cards.create({
    type: 'code',
    parent: 'project',
    title: 'dependent',
    bootstrap_content: 'brief',
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [leaf.id],
  });
  const path = cardHeadFile(f.root, dependent.id);
  const before = fs.readFileSync(path);
  breakSelections(f.root, goal.id);
  const target = `card:${goal.id}`;
  consentDiscard(target);
  await run([...f.args(target), '--discard-card', '--card-type', 'goal']);
  expect(fs.readFileSync(path)).toEqual(before);
  expect(() => initializeAndValidateCurrentGeneratedState(f.root, TEST_WORKFLOWS)).toThrow(
    /current linked card graph/,
  );
  expect(fs.readFileSync(path)).toEqual(before);
});
it.each(['ftruncate', 'fsync', 'close'] as const)(
  'tail %s uncertainty reaches fatal without report update, follow-up reads or descriptor/lock/prompt cleanup',
  async (phase) => {
    const f = fixture();
    const session = 'agent:planner:project';
    const target = `conversation:${session}`;
    appendConversationBatch({ projectRoot: f.root }, [
      {
        id: 'text',
        session_id: session,
        role: 'user',
        kind: 'text',
        content: 'hello',
        timestamp: '2026-10-04T00:00:00.000Z',
        context_policy: TEXT_ROW_POLICY,
        round_id: `r-user-${'0'.repeat(32)}`,
        message_index: 1,
        block_index: 0,
      },
    ]);
    const segment = readCurrentConversationSegment(f.root, session)!;
    const path = join(
      f.root,
      '.saivage',
      'cards',
      'project',
      'conversations',
      'planner',
      'versions',
      segment.entry.filename,
    );
    fs.appendFileSync(path, 'torn');
    question.mockImplementation(async (text) =>
      text.includes('BACKUP COMPLETE') ? `BACKUP COMPLETE ${target}` : `REPAIR ${target}`,
    );
    const originalOpen = fs.openSync,
      originalTruncate = fs.ftruncateSync,
      originalFsync = fs.fsyncSync,
      originalClose = fs.closeSync,
      originalRead = fs.readFileSync,
      originalUnlink = fs.unlinkSync;
    let fd: number | undefined;
    let failed = false;
    const followups: string[] = [];
    jest.spyOn(fs, 'openSync').mockImplementation((path, flags, ...rest) => {
      if (failed) followups.push('open');
      const opened = originalOpen(path, flags, ...rest);
      if (flags === fs.constants.O_RDWR) fd = opened;
      return opened;
    });
    const fail = (name: string, descriptor: number) => {
      if (failed) followups.push(name);
      if (descriptor === fd && name === phase) {
        failed = true;
        throw new Error('uncertain truncation');
      }
    };
    jest.spyOn(fs, 'ftruncateSync').mockImplementation((descriptor, length) => {
      fail('ftruncate', descriptor);
      originalTruncate(descriptor, length);
    });
    jest.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      fail('fsync', descriptor);
      originalFsync(descriptor);
    });
    jest.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      fail('close', descriptor);
      originalClose(descriptor);
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (failed) followups.push('read');
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync);
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (failed) followups.push('unlink');
      originalUnlink(path);
    });
    syncBuiltinESMExports();
    // Reload the real owner modules after replacing Node primitives: growing-file owns
    // its I/O function tuple at module evaluation, rather than exposing a CLI test seam.
    jest.resetModules();
    jest.unstable_mockModule('node:fs', () => ({ ...fs }));
    const { handleRepair } = await import('../../src/cli-repair.js');
    const sentinel = new Error('fatal boundary');
    const fatal = {
      publicationOutcomeUnknown: jest.fn((_error: unknown): never => {
        throw sentinel;
      }),
    };
    await expect(handleRepair({ target, backup: f.backup, report: f.report }, fatal)).rejects.toBe(
      sentinel,
    );
    expect(fatal.publicationOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(followups).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    expect(originalRead(f.report, 'utf8')).not.toContain('Completed:');
    expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(true);
    // Test teardown only: a real fatal boundary terminates the process with this descriptor open.
    if (fd !== undefined) originalClose(fd);
  },
);
it.each(['discard-move', 'restored-head'] as const)(
  '%s rename uncertainty is fatal before report completion, reads, logs, descriptor cleanup or lifecycle release',
  async (mode) => {
    const f = fixture();
    if (mode === 'discard-move') breakSelections(f.root, f.child.id);
    else {
      f.cards.editCard(f.child.id, { title: 'newer' });
      fs.unlinkSync(cardHeadFile(f.root, f.child.id));
      fs.writeFileSync(cardHeadFile(f.root, f.child.id), 'broken');
    }
    const target = `card:${f.child.id}`;
    consentDiscard(target);
    const source = cardHeadFile(f.root, f.child.id);
    let failed = false;
    const after: string[] = [];
    const originalRename = fs.renameSync,
      originalRead = fs.readFileSync,
      originalClose = fs.closeSync,
      originalUnlink = fs.unlinkSync,
      originalOpen = fs.openSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failed) after.push('rename');
      if (mode === 'discard-move' ? String(from) === source : String(to) === source) {
        failed = true;
        throw new Error('unknown publication');
      }
      originalRename(from, to);
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (failed) after.push('read');
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync);
    jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (failed) after.push('close');
      originalClose(fd);
    });
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (failed) after.push('unlink');
      originalUnlink(path);
    });
    jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (failed) after.push('open');
      return originalOpen(...args);
    });
    jest.spyOn(console, 'log').mockImplementation(() => {
      if (failed) after.push('log');
    });
    syncBuiltinESMExports();
    jest.resetModules();
    jest.unstable_mockModule('node:fs', () => ({ ...fs }));
    const { handleRepair } = await import('../../src/cli-repair.js');
    const sentinel = new Error('fatal discard');
    const fatal = {
      publicationOutcomeUnknown: jest.fn((_error: unknown): never => {
        throw sentinel;
      }),
    };
    await expect(
      handleRepair(
        {
          target,
          backup: f.backup,
          report: f.report,
          discardCard: mode === 'discard-move',
          cardType: mode === 'discard-move' ? 'code' : undefined,
        },
        fatal,
      ),
    ).rejects.toBe(sentinel);
    expect(after).toEqual([]);
    expect(fatal.publicationOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(originalRead(f.report, 'utf8')).not.toContain('Exact repaired owner validated');
    expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(true);
  },
);
it('reports six known discard moves but not failed synthetic publication, releases known-failure ownership and never retries', async () => {
  const f = fixture();
  breakSelections(f.root, f.child.id);
  const target = `card:${f.child.id}`;
  consentDiscard(target);
  const path = cardHistoryRoot(f.root, f.child.id);
  const original = fs.mkdirSync;
  let attempts = 0;
  jest.spyOn(fs, 'mkdirSync').mockImplementation(((
    name: fs.PathLike,
    options?: fs.MakeDirectoryOptions,
  ) => {
    if (String(name) === path) {
      attempts++;
      throw new Error('known directory failure');
    }
    return original(name, options);
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();
  jest.resetModules();
  jest.unstable_mockModule('node:fs', () => ({ ...fs }));
  const { run: freshRun } = await import('../../src/cli.js');
  await expect(
    freshRun([...f.args(target), '--discard-card', '--card-type', 'code']),
  ).rejects.toThrow('Repair stopped');
  expect(attempts).toBe(1);
  const report = fs.readFileSync(f.report, 'utf8');
  expect(report.split('\n').filter((line) => line.startsWith('Completed:'))).toHaveLength(6);
  expect(report).not.toContain('Completed: Publish synthetic');
  expect(fs.existsSync(cardHeadFile(f.root, f.child.id))).toBe(false);
  expect(fs.existsSync(runtimeProcessLockFile(f.root))).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
});
