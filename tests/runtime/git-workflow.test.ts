import { afterAll, expect, test, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runGitWorkflow,
  nativeGitRefs,
  type NativeGitRequest,
} from '../../src/runtime/git-workflow.js';
import { randomUUID } from 'node:crypto';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { pathToFileURL } from 'node:url';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import type { CardGitFacts } from '../../src/schemas/git-source.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { cardParentId } from '../../src/schemas/card-id.js';
import { cardRecordsRoot } from '../../src/persistence/layout.js';

jest.setTimeout(120000);

const scratch = '/home/salva/g/ml/tmp/2026-10-25-native-hybrid-git-a6/native';
const identity = {
  GIT_AUTHOR_NAME: 'Native fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Native fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const priorIdentity = Object.fromEntries(
  Object.keys(identity).map((key) => [key, process.env[key]]),
);

async function argvStep(request: NativeGitRequest, stopAfter?: 'normalize' | 'abort', deadline = 120000) {
  const composition = createTestProcessRunner(request.project_root);
  const controller = new AbortController();
  const runner = composition.processRunner;
  let stopProcess: string | undefined;
  if (stopAfter) {
    const spawn = runner.spawnCaptured.bind(runner);
    jest.spyOn(runner, 'spawnCaptured').mockImplementation((spec) => {
      const record = spawn(spec);
      if ((stopAfter === 'normalize' && spec.args?.slice(0, 3).join(' ') === 'read-tree --reset -i') ||
          (stopAfter === 'abort' && spec.args?.join(' ') === 'rebase --abort')) stopProcess = record.id;
      return record;
    });
    const retire = runner.retireSettled.bind(runner);
    jest.spyOn(runner, 'retireSettled').mockImplementation((...args) => {
      const result = retire(...args);
      if (args[0] === stopProcess) controller.abort();
      return result;
    });
  }
  const cardId = 'owner' in request ? request.owner.card_id : 'project';
  mkdirSync(cardRecordsRoot(request.project_root, cardId), { recursive: true });
  return runGitWorkflow({ request: { ...request, timeout_ms: deadline }, runner: composition.processRunner, parentScope: composition.runtimeProcessRootScope,
    invocationId: 'invocation_id' in request ? request.invocation_id : randomUUID(), cardId,
    signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); },
    binding: request.step === 'commission' ? { origin: 'bootstrap' } :
      { origin: 'activation', activation_id: randomUUID(), parent_card_id: cardParentId(cardId), node: null } });
}

// Caller-contract/native mechanics only. Canonical publication and ownership
// remain separate required CardService/Supervisor integration witnesses.
test.each([
  ['file-to-directory', 'clean'],
  ['directory-to-file', 'clean'],
  ['directory-to-file', 'regular-clean'],
  ['file-to-directory', 'ignored-obstruction'],
  ['directory-to-file', 'ignored-obstruction'],
  ['file-to-directory', 'normalization-hook'],
  ['file-to-directory', 'async-wait-abort'],
  ['file-to-directory', 'async-obstruction'],
  ['file-to-directory', 'async-benign-clean'],
  ['directory-to-file', 'abort-hook'],
  ['file-to-directory', 'unmerged-prefix-clean'],
  ['file-to-directory', 'unknown-directory'],
  ['file-to-directory', 'nonignored-directory'],
  ['file-to-directory', 'excluded-directory'],
  ['file-to-directory', 'absent-ignored-directory'],
  ['file-to-directory', 'normalization-observation-clean'],
  ['file-to-directory', 'changed-source'],
  ['file-to-directory', 'changed-N'],
  ['file-to-directory', 'changed-Q'],
  ['file-to-directory', 'no-owner'],
  ['file-to-directory', 'merge-authority'],
  ['file-to-directory', 'normalization-failure'],
  ['file-to-directory', 'abort-failure'],
  ['file-to-directory', 'stop-after-normalize'],
  ['file-to-directory', 'stop-after-abort'],
] as const)('typed preservation %s / %s', async (direction, scenario) => {
  const { root, request: fixtureRequest } = fixture();
  const request = { ...fixtureRequest, timeout_ms: 30000 };
  if (direction === 'file-to-directory') writeFileSync(join(root, 'd'), 'N file');
  else { mkdirSync(join(root, 'd')); writeFileSync(join(root, 'd', 'source.ts'), 'N descendant'); }
  writeFileSync(join(root, '.gitignore'), '.saivage/\ncache/\n**/local-cache\nd/private/\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'typed B');
  const base = git(root, 'rev-parse', 'HEAD');
  const owner = { namespace: 'refs/saivage/typed', card_id: 'card-d' };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'tracked'), 'C\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'C conflict');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'private');
  writeFileSync(join(root, 'tracked'), 'P\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'P conflict');
  const parent = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const entered = (await argvStep({ ...request, step: 'enter', expected: parent, owner, invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: null } }));
  if (entered.kind !== 'correction-required') throw new Error(JSON.stringify(entered));
  if (scenario === 'merge-authority') {
    git(root, 'switch', '-c', 'side', base);
    writeFileSync(join(root, 'side'), 'side'); git(root, 'add', 'side'); git(root, 'commit', '-m', 'side');
    git(root, 'switch', names.branch_ref.slice(11)); git(root, 'merge', '--no-ff', '-m', 'merge', 'side');
  }
  expect(spawnSync('git', ['rebase', '--onto', parent.observed_tip, base],
    { cwd: root, env: process.env, timeout: 5000 }).status).toBe(1);
  if (direction === 'file-to-directory') {
    unlinkSync(join(root, 'd')); mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'source.ts'), 'S descendant');
    chmodSync(join(root, 'd', 'source.ts'), 0o755);
  } else {
    unlinkSync(join(root, 'd', 'source.ts')); rmdirSync(join(root, 'd'));
    if (scenario === 'regular-clean') writeFileSync(join(root, 'd'), 'S regular replacement');
    else symlinkSync('tracked', join(root, 'd'));
  }
  if (scenario === 'unmerged-prefix-clean') {
    // Exact real index prefix conflict: all stages are membership, neither blob
    // becomes the final source. No fake helper result or mocked index consumer.
    const oldBlob = git(root, 'rev-parse', `${original}:d`);
    const newBlob = git(root, 'hash-object', '-w', 'd/source.ts');
    const result = spawnSync('git', ['update-index', '-z', '--index-info'], { cwd: root,
      env: process.env, encoding: 'utf8', timeout: 5000,
      input: `0 ${'0'.repeat(40)}\td\0` + `100644 ${oldBlob} 2\td\0` + `100755 ${newBlob} 3\td/source.ts\0` });
    expect(result.status).toBe(0);
    expect(git(root, 'ls-files', '--stage')).toContain(' 2\td');
    expect(git(root, 'ls-files', '--stage')).toContain(' 3\td/source.ts');
  }
  if (scenario === 'absent-ignored-directory') {
    unlinkSync(join(root, 'deleted'));
    writeFileSync(join(root, '.gitignore'), '.saivage/\ncache/\n**/local-cache\ndeleted/\n');
  }
  if (scenario === 'normalization-observation-clean') {
    unlinkSync(join(root, 'deleted'));
    writeFileSync(join(root, 'new'), 'new partial source');
    chmodSync(join(root, 'executable'), 0o755);
    unlinkSync(join(root, 'link')); symlinkSync('new', join(root, 'link'));
  }
  mkdirSync(join(root, 'cache'), { recursive: true });
  writeFileSync(join(root, 'cache', 'unrelated'), 'not selected or inspected');
  const expected = { branch_ref: names.branch_ref, observed_tip: original };
  const realIndex = readFileSync(join(root, '.git', 'index'));
  const capture = (await argvStep({ ...request, step: 'captureRebase',
    expected: scenario === 'no-owner' ? { ...expected, observed_tip: base } : expected,
    allow_owned_commits: scenario === 'merge-authority',
    task: entered.task, owner, invocation_id: randomUUID() }));
  if (scenario === 'no-owner' || scenario === 'merge-authority') {
    expect(capture).toMatchObject({ kind: 'refused', effects: [] });
    if (capture.kind === 'refused') expect(capture.reason).toContain(
      scenario === 'no-owner' ? 'without active ownership' : 'not a linear owned advancement');
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
    return;
  }
  if (capture.kind !== 'captured') throw new Error(JSON.stringify(capture));
  expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
  const snapshotTree = git(root, 'rev-parse', `${capture.preserved_source.oid}^{tree}`);
  if (scenario === 'ignored-obstruction') {
    // Reverse case replaces selected S leaf by an ignored directory; refusal
    // must precede normalization even though neither ignored byte is in S.
    if (direction === 'directory-to-file') { unlinkSync(join(root, 'd')); mkdirSync(join(root, 'd')); }
    writeFileSync(join(root, 'd', 'local-cache'), 'keep ignored');
  }
  const unknown = scenario === 'excluded-directory' ? 'private' : scenario === 'nonignored-directory' ? 'new-subdir' : 'local-cache';
  if (['unknown-directory', 'nonignored-directory', 'excluded-directory'].includes(scenario)) {
    mkdirSync(join(root, 'd', unknown));
    writeFileSync(join(root, 'd', unknown, 'must-not-open'), 'uncaptured private bytes');
  }
  if (scenario === 'absent-ignored-directory') {
    mkdirSync(join(root, 'deleted')); writeFileSync(join(root, 'deleted', 'must-not-open'), 'ignored obstruction');
  }
  if (scenario === 'changed-source') writeFileSync(join(root, 'tracked'), 'changed after capture');
  if (scenario === 'changed-N') git(root, 'update-ref', names.branch_ref, base);
  if (scenario === 'changed-Q') git(root, 'update-ref', '--no-deref', 'HEAD', original);
  if (scenario === 'normalization-observation-clean') {
    // Finite hook records exact selected source and metadata, without Git writes.
    const observer = join(root, '.git', 'observe.py');
    writeFileSync(observer, `import os,json,hashlib,subprocess\npaths=['.gitignore','tracked','deleted','new','executable','link','d/source.ts','cache/unrelated']\ndef observe():\n out={}\n for p in paths:\n  try: st=os.lstat(p)\n  except FileNotFoundError: out[p]=None;continue\n  data=os.readlink(p).encode() if os.path.islink(p) else open(p,'rb').read();out[p]=[st.st_mode,hashlib.sha256(data).hexdigest()]\n meta={p:hashlib.sha256(open('.git/rebase-merge/'+p,'rb').read()).hexdigest() for p in os.listdir('.git/rebase-merge')}\n for p in ['HEAD',${JSON.stringify(names.branch_ref)}]:meta[p]=subprocess.check_output(['git','rev-parse',p],env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}).decode()\n return {'source':out,'metadata':meta,'index':subprocess.check_output(['git','ls-files','--stage','-z'],env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}).decode()}\nprint(json.dumps(observe(),sort_keys=True))\n`);
    const before = spawnSync('/usr/bin/python3', [observer], { cwd: root, encoding: 'utf8', timeout: 5000 });
    expect(before.status).toBe(0); writeFileSync(join(root, '.git', 'before-normalization.json'), before.stdout);
    const hook = join(root, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\ncase "$GIT_INDEX_FILE" in *native-git-*) exit 0;; esac\nif test ! -f .git/after-normalization.json; then /usr/bin/python3 .git/observe.py > .git/after-normalization.json; fi\n`);
    chmodSync(hook, 0o755);
  }
  if (scenario.endsWith('hook')) {
    const at = scenario === 'normalization-hook' ? 1 : 2;
    const hook = join(root, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\ncase "$GIT_INDEX_FILE" in *native-git-*) exit 0;; esac\nn=0\nif test -f .git/typed-hook-count; then read n < .git/typed-hook-count; fi\nn=$((n+1))\nprintf '%s\\n' "$n" > .git/typed-hook-count\nif test "$n" = ${at}; then printf 'keep hook bytes' > d/local-cache; fi\n`);
    chmodSync(hook, 0o755);
  }
  const gitBinary = spawnSync('which', ['git'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
  if (scenario.startsWith('async-')) {
    const body = scenario === 'async-wait-abort'
      ? 'for i in $(seq 1 1200); do if test -f .git/abort-started; then printf lost > d/local-cache; exit 0; fi; sleep 0.1; done'
      : `sleep 0.1; ${scenario === 'async-obstruction' ? "printf 'keep hook bytes' > d/local-cache" : 'printf benign > .git/benign-child'}`;
    const hook = join(root, '.git/hooks/post-index-change');
    writeFileSync(hook, `#!/bin/sh\ncase "$GIT_INDEX_FILE" in *native-git-*) exit 0;; esac\nif test ! -f .git/async-once; then\ntouch .git/async-once\n( ${body} ) </dev/null >/dev/null 2>&1 &\nprintf '%s' "$!" > .git/async-pid\nfi\n`);
    chmodSync(hook, 0o755);
  }
  const tools = join(root, '.git', 'native-tools'); mkdirSync(tools);
  const trace = join(root, '.git', 'native-argv.jsonl');
  const failedCommand = scenario === 'normalization-failure' ? ['read-tree', '--reset', '-i'] :
    scenario === 'abort-failure' ? ['rebase', '--abort'] : [];
  writeFileSync(join(tools, 'git'), `#!/usr/bin/python3\nimport os,sys,json\nwith open(${JSON.stringify(trace)},'a') as f: f.write(json.dumps({'argv':sys.argv[1:],'index':os.environ.get('GIT_INDEX_FILE'),'optional':os.environ.get('GIT_OPTIONAL_LOCKS')})+'\\n')\nif sys.argv[1:]==['rebase','--abort']: open('.git/abort-started','w').close()\nfail=${JSON.stringify(failedCommand)}\nif fail and sys.argv[1:1+len(fail)]==fail: sys.exit(73)\nos.execv(${JSON.stringify(gitBinary)},[${JSON.stringify(gitBinary)}]+sys.argv[1:])\n`);
  chmodSync(join(tools, 'git'), 0o755);
  const oldPath = process.env.PATH;
  let result;
  try {
    process.env.PATH = `${tools}:${oldPath}`;
    writeSync(2, `NATIVE_TRACE_BEGIN ${root}\n`);
    result = (await argvStep({ ...request,
      source: scenario === 'excluded-directory' ? { ...request.source, excluded_paths: [...request.source.excluded_paths, 'd/private'] } : request.source,
      step: 'restoreRebaseAndReturn', expected, allow_owned_commits: false,
      task: entered.task, owner, invocation_id: randomUUID(), preserved_source: capture.preserved_source,
      rebase_observation: capture.rebase_observation },
      scenario === 'stop-after-normalize' ? 'normalize' : scenario === 'stop-after-abort' ? 'abort' : undefined,
      scenario === 'async-wait-abort' ? 60000 : 120000));
  } catch (error) {
    if (!scenario.startsWith('stop-after-')) throw error;
    expect(error).toMatchObject({ name: 'AbortError' });
  } finally { writeSync(2, `NATIVE_TRACE_END ${root}\n`); process.env.PATH = oldPath; }
  const calls = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as
    { argv: string[]; index: string | null; optional: string });
  const normalization = calls.findIndex((call) => call.argv.join(' ').startsWith('read-tree --reset -i '));
  const abort = calls.findIndex((call) => call.argv.join(' ') === 'rebase --abort');
  const restore = calls.findIndex((call) => call.argv.includes('restore'));
  if (scenario.startsWith('stop-after-')) {
    expect(result).toBeUndefined();
    expect(normalization).toBeGreaterThanOrEqual(0); expect(restore).toBe(-1);
    if (scenario === 'stop-after-normalize') expect(abort).toBe(-1);
    else expect(abort).toBeGreaterThan(normalization);
    expect(calls.at(-1)!.argv.slice(0, scenario === 'stop-after-normalize' ? 3 : 2)).toEqual(
      scenario === 'stop-after-normalize' ? ['read-tree', '--reset', '-i'] : ['rebase', '--abort']);
    expect(git(root, 'rev-parse', entered.task.retained_original_ref)).toBe(original);
    expect(git(root, 'rev-parse', capture.preserved_source.ref)).toBe(capture.preserved_source.oid);
    return;
  }
  if (!result) throw new Error('Expected a settled native result');
  if (scenario === 'async-wait-abort') {
    expect(result.kind).toBe('uncertain');
    expect(normalization).toBeGreaterThanOrEqual(0); expect(abort).toBe(-1); expect(restore).toBe(-1);
    expect(calls.at(-1)!.argv.slice(0, 3)).toEqual(['read-tree', '--reset', '-i']);
    expect(result.effects).not.toContain('index-normalized');
    expect(readFileSync(join(root, 'd/source.ts'), 'utf8')).toBe('S descendant');
    const rows = readCardExecutions(root, owner.card_id);
    expect(rows.at(-1)).toMatchObject({ kind: 'native_process_finished', disposition: 'timed_out', status: 'killed',
      leader_exit: { exit_code: 0 }, process: { group: 'absent' } });
    return;
  }
  if (scenario.endsWith('failure')) {
    expect(result.kind).toBe('uncertain'); expect(restore).toBe(-1);
    expect(result.effects).not.toContain('rebase-aborted');
    expect(result.effects).not.toContain('source-restored');
    if (scenario === 'normalization-failure') {
      expect(result.effects).not.toContain('index-normalized'); expect(abort).toBe(-1);
      expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
    } else {
      expect(result.effects).toContain('index-normalized'); expect(abort).toBeGreaterThan(normalization);
    }
    expect(calls.filter((call) => call.argv.slice(0, failedCommand.length).join(' ') === failedCommand.join(' '))).toHaveLength(1);
    // No diagnosis/readback after the failed command in the helper itself.
    expect(calls.at(-1)!.argv.slice(0, failedCommand.length)).toEqual(failedCommand);
    return;
  }
  const readOnly = new Set(['ls-files', 'ls-tree', 'rev-parse', 'check-ref-format', 'merge-base', 'rev-list',
    'symbolic-ref', 'config', 'check-ignore', 'check-attr', 'status']);
  if (normalization >= 0) {
    expect(calls[normalization]!.index).toBeNull();
    for (const call of calls.slice(normalization + 1, abort < 0 ? undefined : abort)) {
      expect(readOnly.has(call.argv[0]!)).toBe(true);
      expect(call.optional).toBe('0');
    }
  }
  if (abort >= 0) for (const call of calls.slice(abort + 1, restore < 0 ? undefined : restore)) {
    expect(readOnly.has(call.argv[0]!)).toBe(true);
    expect(call.optional).toBe('0');
  }
  if (scenario.endsWith('clean')) {
    if (result.kind !== 'returned') throw new Error(JSON.stringify(result));
    expect(result.effects).toContain('index-normalized');
    expect(result.effects.filter((e) => e === 'rebase-aborted')).toHaveLength(1);
    expect(git(root, 'rev-parse', `${result.source.observed_tip}^{tree}`)).toBe(snapshotTree);
    expect(git(root, 'rev-parse', `${result.source.observed_tip}^`)).toBe(original);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(parent.observed_tip);
    expect(git(root, 'status', '--porcelain')).toBe('');
  } else {
    expect(result.kind).toBe('refused');
    expect(result.effects).not.toContain('source-restored');
    expect(result.effects).not.toContain('checkout-completed');
    if (!scenario.endsWith('hook') && scenario !== 'async-obstruction') {
      expect(normalization).toBe(-1); expect(abort).toBe(-1); expect(restore).toBe(-1);
      expect(result.effects).not.toContain('index-normalized');
      expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
    } else {
      expect(result.effects).toContain('index-normalized');
      expect(readFileSync(join(root, 'd', 'local-cache'), 'utf8')).toBe('keep hook bytes');
      if (scenario === 'normalization-hook' || scenario === 'async-obstruction') {
        expect(abort).toBe(-1); expect(restore).toBe(-1);
        expect(result.effects).not.toContain('rebase-aborted');
        const stage0 = git(root, 'ls-files', '--stage', '-z').split('\0').filter(Boolean)
          .map((entry) => entry.replace(/ ([0-3])\t/u, '\t')).sort();
        const treeLeaves = git(root, 'ls-tree', '-r', '-z', snapshotTree).split('\0').filter(Boolean)
          .map((entry) => entry.replace(' blob ', ' ')).sort();
        expect(stage0).toEqual(treeLeaves);
        expect(readFileSync(join(root, 'd', 'source.ts'), 'utf8')).toBe('S descendant');
      } else {
        expect(result.effects).toContain('rebase-aborted');
        expect(abort).toBeGreaterThan(normalization); expect(restore).toBe(-1);
      }
    }
  }
  if (scenario === 'normalization-observation-clean') {
    const before = JSON.parse(readFileSync(join(root, '.git', 'before-normalization.json'), 'utf8'));
    const after = JSON.parse(readFileSync(join(root, '.git', 'after-normalization.json'), 'utf8'));
    expect(after.source).toEqual(before.source); expect(after.metadata).toEqual(before.metadata);
    expect(after.index).not.toBe(before.index);
    const expectedIndex = git(root, 'ls-tree', '-r', '-z', snapshotTree).split('\0').filter(Boolean)
      .map((entry) => entry.replace(' blob ', ' ').replace('\t', ' 0\t')).sort();
    expect(after.index.split('\0').filter(Boolean).sort()).toEqual(expectedIndex);
  }
  expect(git(root, 'rev-parse', entered.task.retained_original_ref)).toBe(original);
  expect(git(root, 'rev-parse', capture.preserved_source.ref)).toBe(capture.preserved_source.oid);
  expect(readFileSync(join(root, 'cache', 'unrelated'), 'utf8')).toBe('not selected or inspected');
}, 300000);

test('N3 squash uses the actual parent index; no-change creates no empty commit and stale dirt refuses', async () => {
  const { root, tip, request } = fixture();
  writeFileSync(join(root, 'tracked'), 'accepted source');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'accepted C');
  const child = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const parent = { branch_ref: 'refs/heads/main', observed_tip: tip };
  writeFileSync(join(root, 'tracked'), 'later dirt');
  expect(
    (await argvStep({ ...request, step: 'deliver', expected: child, parent })),
  ).toMatchObject({ kind: 'refused', effects: [] });
  writeFileSync(join(root, 'tracked'), 'accepted source');
  const delivered = (await argvStep({ ...request, step: 'deliver', expected: child, parent }));
  expect(delivered.kind).toBe('delivered');
  if (delivered.kind !== 'delivered') throw new Error(JSON.stringify(delivered));
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe(parent.branch_ref);
  expect(git(root, 'rev-parse', 'HEAD^')).toBe(tip);
  expect(git(root, 'write-tree')).toBe(git(root, 'rev-parse', `${child.observed_tip}^{tree}`));
  expect(readFileSync(join(root, 'tracked'), 'utf8')).toBe('accepted source');
  expect(git(root, 'status', '--porcelain')).toBe('');
  const noChange = fixture();
  const empty = (await argvStep({
    ...noChange.request,
    step: 'deliver',
    parent: { branch_ref: 'refs/heads/main', observed_tip: noChange.tip },
  }));
  expect(empty).toMatchObject({
    kind: 'delivered',
    parent_before: noChange.tip,
    parent_after: noChange.tip,
  });
  expect(empty.effects).not.toContain('commit-completed');
});

test('N3 ordinary failure return checkpoints actual dirty source without delivering it', async () => {
  const { root, tip, request } = fixture();
  writeFileSync(join(root, 'new'), 'failed work');
  const result = (await argvStep({
    ...request,
    step: 'preserveAndReturn',
    parent: { branch_ref: 'refs/heads/main', observed_tip: tip },
    task: null,
  }));
  expect(result.kind).toBe('returned');
  if (result.kind !== 'returned') throw new Error(JSON.stringify(result));
  expect(git(root, 'rev-parse', 'HEAD')).toBe(tip);
  expect(git(root, 'show', `${result.source.observed_tip}:new`)).toBe('failed work');
  expect(git(root, 'ls-tree', 'HEAD', 'new')).toBe('');
});

test('N3 partial c1 capture and separate restore preserve original c2 and P without treating snapshot as endpoint', async () => {
  const { root, tip: base, request } = fixture();
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({ type: 'code', parent: 'project', title: 'native source', bootstrap_content: 'source',
    priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  const owner = { namespace: 'refs/saivage/partial', card_id: card.id };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'tracked'), 'c1\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'c1');
  writeFileSync(join(root, 'c2-only'), 'original c2');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'c2');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'private');
  writeFileSync(join(root, 'tracked'), 'P\n');
  writeFileSync(join(root, 'parent-only'), 'P-only');
  git(root, 'add', '--all');
  writeFileSync(join(root, '.gitignore'), '.saivage/\ncache/\nparent-only\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-m', 'P');
  const parent = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const entered = (await argvStep({
    ...request,
    step: 'enter',
    expected: parent,
    owner,
    invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: null },
  }));
  if (entered.kind !== 'correction-required') throw new Error(JSON.stringify(entered));
  let facts: CardGitFacts = { kind: 'child', branch_ref: names.branch_ref, parent, base_oid: base,
    observed_tip: original, candidate: null, last_delivery: null,
    correction: { ...entered.task, preserved_source: null } };
  cards.publishGitFacts(card.id, facts);
  const replay = spawnSync('git', ['rebase', '--onto', parent.observed_tip, base], {
    cwd: root,
    env: process.env,
    timeout: 5000,
  });
  expect(replay.status).toBe(1);
  writeFileSync(join(root, 'tracked'), 'useful partial c1 and P\n');
  writeFileSync(join(root, 'new'), 'new resolution source');
  unlinkSync(join(root, 'deleted'));
  chmodSync(join(root, 'executable'), 0o755);
  unlinkSync(join(root, 'link'));
  symlinkSync('new', join(root, 'link'));
  const realIndex = readFileSync(join(root, '.git', 'index'));
  expect(
    (await argvStep({
      project_root: root,
      source: { ...request.source, excluded_paths: [...request.source.excluded_paths, 'new'] },
      timeout_ms: 10000,
      step: 'captureRebase',
      expected: { branch_ref: names.branch_ref, observed_tip: original },
      allow_owned_commits: true,
      task: entered.task,
      owner,
      invocation_id: randomUUID(),
    })),
  ).toMatchObject({ kind: 'refused', effects: [] });
  expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
  const capture = (await argvStep({
    project_root: root,
    source: request.source,
    timeout_ms: 10000,
    step: 'captureRebase',
    expected: { branch_ref: names.branch_ref, observed_tip: original },
    allow_owned_commits: true,
    task: entered.task,
    owner,
    invocation_id: randomUUID(),
  }));
  if (capture.kind !== 'captured') throw new Error(JSON.stringify(capture));
  facts = { ...facts, correction: { ...capture.task, preserved_source: capture.preserved_source } };
  cards.publishGitFacts(card.id, facts);
  expect(cards.read(card.id)!.git!.correction!.preserved_source).toEqual(capture.preserved_source);
  expect(readFileSync(join(root, '.git', 'index'))).toEqual(realIndex);
  expect(capture.preserved_source.source_tip).toBe(parent.observed_tip);
  expect(capture.task.original_tip).toBe(original);
  expect(git(root, 'show', `${capture.task.retained_original_ref}:c2-only`)).toBe('original c2');
  expect(git(root, 'ls-tree', capture.preserved_source.oid, 'c2-only')).toBe('');
  expect(git(root, 'show', `${capture.preserved_source.oid}:parent-only`)).toBe('P-only');
  expect(git(root, 'ls-files', '--unmerged')).not.toBe('');
  // A successful caller publication would be here. No native helper remains
  // running or has aborted; the following request is an independent invocation.
  const restore = {
    project_root: root,
    source: request.source,
    timeout_ms: 10000,
    step: 'restoreRebaseAndReturn' as const,
    expected: { branch_ref: names.branch_ref, observed_tip: original },
    allow_owned_commits: true,
    rebase_observation: capture.rebase_observation,
    task: capture.task,
    preserved_source: capture.preserved_source,
    owner,
    invocation_id: randomUUID(),
  };
  writeFileSync(join(root, 'tracked'), 'later writer');
  const refused = (await argvStep(restore));
  expect(refused.kind).toBe('refused');
  expect(refused.effects).not.toContain('rebase-aborted');
  expect(git(root, 'ls-files', '--unmerged')).not.toBe('');
  writeFileSync(join(root, 'tracked'), 'useful partial c1 and P\n');
  const returned = (await argvStep({ ...restore, invocation_id: randomUUID() }));
  if (returned.kind !== 'returned') throw new Error(JSON.stringify(returned));
  facts = { ...facts, observed_tip: returned.source.observed_tip };
  cards.publishGitFacts(card.id, facts);
  expect(returned.task).toEqual(entered.task);
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe(parent.branch_ref);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(parent.observed_tip);
  const saved = returned.source.observed_tip;
  expect(git(root, 'rev-parse', `${saved}^{tree}`)).toBe(
    git(root, 'rev-parse', `${capture.preserved_source.oid}^{tree}`),
  );
  expect(git(root, 'ls-tree', saved, 'deleted')).toBe('');
  expect(git(root, 'ls-tree', saved, 'executable')).toMatch(/^100755 /);
  expect(git(root, 'show', `${saved}:link`)).toBe('new');
  expect(git(root, 'show', `${saved}:new`)).toBe('new resolution source');
  expect(git(root, 'show', `${capture.task.retained_original_ref}:c2-only`)).toBe('original c2');
  // Scripted correction reconstructs from both explicit inputs on the existing
  // source branch. It never replays the partial snapshot as the original B..C.
  git(root, 'switch', names.branch_ref.slice(11));
  git(
    root,
    'restore',
    '--source',
    capture.task.retained_original_ref,
    '--staged',
    '--worktree',
    '--',
    'c2-only',
  );
  git(root, 'commit', '-m', 'restore original c2 after partial preservation');
  writeFileSync(join(root, 'later-only'), 'later owned ignored source');
  writeFileSync(join(root, 'later-deleted'), 'later deletion source');
  writeFileSync(join(root, 'later-mode'), 'later executable source');
  symlinkSync('tracked', join(root, 'later-link'));
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'later owned source membership');
  const nativeStart = git(root, 'rev-parse', 'HEAD');
  // Keep actual restored history and merge parent ancestry through explicit
  // correction rebase of just the preservation delta, not helper replay.
  const corrected = spawnSync('git', ['rebase', '--onto', parent.observed_tip, original], {
    cwd: root,
    env: process.env,
    timeout: 5000,
  });
  expect(corrected.status).toBe(1);
  writeFileSync(join(root, 'tracked'), 'second useful resolution\n');
  writeFileSync(join(root, 'later-only'), 'later owned ignored source');
  writeFileSync(join(root, '.gitignore'), '.saivage/\ncache/\nparent-only\nlater-only\n');
  writeFileSync(join(root, 'later-mode'), 'later executable source');
  chmodSync(join(root, 'later-mode'), 0o755);
  symlinkSync('later-only', join(root, 'later-link'));
  writeFileSync(join(root, 'second-new'), 'new second resolution');
  // A second interruption must preserve source without replacing original C
  // with the prior partial checkpoint or this correction's starting tip.
  const secondRequest = {
    project_root: root,
    source: request.source,
    timeout_ms: 10000,
    step: 'captureRebase' as const,
    // Actual CardService publication now supplies O. Active-owner permission
    // still belongs to the forthcoming Supervisor integration, not this fixture.
    expected: { branch_ref: facts.branch_ref, observed_tip: cards.read(card.id)!.git!.observed_tip },
    allow_owned_commits: true,
    task: entered.task,
    owner,
    invocation_id: randomUUID(),
  };
  expect((await argvStep({ ...secondRequest, invocation_id: randomUUID(), allow_owned_commits: false }))).toMatchObject({ kind: 'refused', effects: [] });
  expect((await argvStep({ ...secondRequest, invocation_id: randomUUID(), expected: parent }))).toMatchObject({ kind: 'refused', effects: [] });
  const secondCapture = (await argvStep(secondRequest));
  expect(secondCapture.kind).toBe('captured');
  if (secondCapture.kind !== 'captured') throw new Error(JSON.stringify(secondCapture));
  facts = { ...facts, correction: { ...secondCapture.task, preserved_source: secondCapture.preserved_source } };
  cards.publishGitFacts(card.id, facts);
  expect(secondCapture.rebase_observation.starting_tip).toBe(nativeStart);
  expect(secondCapture.rebase_observation.head_tip).toBe(parent.observed_tip);
  expect(secondCapture.preserved_source.source_tip).toBe(parent.observed_tip);
  expect(secondCapture.task.original_tip).toBe(original);
  const secondRestore = { ...restore, expected: returned.source,
    preserved_source: secondCapture.preserved_source, rebase_observation: secondCapture.rebase_observation,
    invocation_id: randomUUID() };
  for (const bad of [ { ...secondCapture.rebase_observation, starting_tip: original },
    { ...secondCapture.rebase_observation, head_tip: original } ])
    expect((await argvStep({ ...secondRestore, invocation_id: randomUUID(), rebase_observation: bad }))).toMatchObject({ kind: 'refused', effects: [] });
  const secondReturn = (await argvStep(secondRestore));
  if (secondReturn.kind !== 'returned') throw new Error(JSON.stringify(secondReturn));
  facts = { ...facts, observed_tip: secondReturn.source.observed_tip };
  cards.publishGitFacts(card.id, facts);
  expect(cards.read(card.id)!.git!.correction!.original_tip).toBe(original);
  const k2 = secondReturn.source.observed_tip;
  expect(git(root, 'rev-parse', `${k2}^`)).toBe(nativeStart);
  expect(git(root, 'rev-parse', `${k2}^{tree}`)).toBe(git(root, 'rev-parse', `${secondCapture.preserved_source.oid}^{tree}`));
  expect(git(root, 'ls-tree', k2, 'later-deleted')).toBe('');
  expect(git(root, 'show', `${k2}:later-only`)).toBe('later owned ignored source');
  expect(git(root, 'ls-tree', k2, 'later-mode')).toMatch(/^100755 /);
  expect(git(root, 'show', `${k2}:later-link`)).toBe('later-only');
  expect(git(root, 'show', `${k2}:second-new`)).toBe('new second resolution');
  expect(secondReturn.task).toEqual(entered.task);
  expect(git(root, 'rev-parse', entered.task.retained_original_ref)).toBe(original);
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe(parent.branch_ref);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(parent.observed_tip);
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect((await argvStep({ ...request, step: 'switch', expected: parent, target: secondReturn.source })).kind).toBe('completed');
  // Reinterrupt without an intervening commit: N = O = returned K2.
  const again = spawnSync('git', ['rebase', '--onto', parent.observed_tip, nativeStart], { cwd: root, env: process.env, timeout: 5000 });
  expect(again.status).toBe(1);
  git(root, 'restore', '--source', secondCapture.preserved_source.oid, '--worktree', '--', '.');
  const thirdCapture = (await argvStep({ ...secondRequest, expected: secondReturn.source,
    allow_owned_commits: false, invocation_id: randomUUID() }));
  if (thirdCapture.kind !== 'captured') throw new Error(JSON.stringify(thirdCapture));
  expect(thirdCapture.rebase_observation.starting_tip).toBe(k2);
  // The correction agent must reconcile the real conflict; cleanliness was
  // never promised as semantic equivalence by either preservation helper.
  git(
    root,
    'restore',
    '--source',
    thirdCapture.preserved_source.oid,
    '--staged',
    '--worktree',
    '--',
    '.',
  );
  const correctionContinued = spawnSync('git', ['rebase', '--continue'], {
    cwd: root,
    env: { ...process.env, GIT_EDITOR: 'true' },
    timeout: 5000,
  });
  expect(correctionContinued.status).toBe(0);
  git(root, 'restore', '--source', entered.task.retained_original_ref, '--staged', '--worktree', '--', 'c2-only');
  git(root, 'commit', '-m', 'explicitly reconstruct original c2');
  expect(readFileSync(join(root, 'c2-only'), 'utf8')).toBe('original c2');
  expect(readFileSync(join(root, 'parent-only'), 'utf8')).toBe('P-only');
  expect(readFileSync(join(root, 'tracked'), 'utf8')).toBe('second useful resolution\n');
  expect(readFileSync(join(root, 'later-only'), 'utf8')).toBe('later owned ignored source');
  expect(readlinkSync(join(root, 'later-link'))).toBe('later-only');
  expect(
    (await argvStep({
      ...request,
      step: 'verifyCorrection',
      task: returned.task!,
      expected: { branch_ref: names.branch_ref, observed_tip: git(root, 'rev-parse', 'HEAD') },
    })).kind,
  ).toBe('correction-verified');
}, 300000);

test('N2 first entry allocates only its exact branch and prepares a factual candidate', async () => {
  const { root, tip, request } = fixture();
  const owner = { namespace: 'refs/saivage/fixture-identity', card_id: 'card-a' };
  const invocation_id = randomUUID();
  const entered = (await argvStep({
    ...request,
    step: 'enter',
    owner,
    invocation_id,
    previous: null,
  }));
  expect(entered.kind).toBe('entered');
  if (entered.kind !== 'entered') throw new Error(JSON.stringify(entered));
  const names = nativeGitRefs(owner, invocation_id);
  expect(entered.observation.branch_ref).toBe(names.branch_ref);
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe(names.branch_ref);
  writeFileSync(join(root, 'new'), 'candidate');
  const expected = { branch_ref: names.branch_ref, observed_tip: tip };
  const candidate = (await argvStep({
    ...request,
    step: 'prepareCandidate',
    expected,
    base_oid: tip,
    parent: request.expected,
  }));
  expect(candidate.kind).toBe('candidate');
  expect(git(root, 'show', 'HEAD:new')).toBe('candidate');
  git(root, 'switch', 'private');
  expect(
    (await argvStep({
      ...request,
      step: 'enter',
      owner,
      invocation_id: randomUUID(),
      previous: null,
    })).kind,
  ).toBe('uncertain');
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/private');
});

test('N2 replay uses stored old B after parent rewrite and retains empty and reapplied owned commits', async () => {
  const { root, tip: ancestor, request } = fixture();
  writeFileSync(join(root, 'parent-old'), 'inherited old parent');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'old parent B');
  const base = git(root, 'rev-parse', 'HEAD');
  const owner = { namespace: 'refs/saivage/nested', card_id: 'card-a-b' };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'owned'), 'owned');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'owned commit');
  git(root, 'commit', '--allow-empty', '-m', 'owned empty');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'main');
  // Rewritten parent descends from older history, not B. It independently has
  // the same patch as the child, which must still remain an owned empty commit.
  expect(git(root, 'rev-parse', 'HEAD')).toBe(ancestor);
  writeFileSync(join(root, 'owned'), 'owned');
  writeFileSync(join(root, 'parent-only'), 'P');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'rewritten P');
  const parent = { branch_ref: 'refs/heads/main', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const result = (await argvStep({
    ...request,
    step: 'enter',
    expected: parent,
    owner,
    invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: null },
  }));
  expect(result.kind).toBe('entered');
  if (result.kind !== 'entered') throw new Error(JSON.stringify(result));
  expect(git(root, 'rev-parse', names.retention_ref)).toBe(original);
  expect(git(root, 'rev-list', '--count', `${parent.observed_tip}..HEAD`)).toBe('2');
  expect(git(root, 'ls-tree', 'HEAD', 'parent-old')).toBe('');
  expect(readFileSync(join(root, 'parent-only'), 'utf8')).toBe('P');
  expect(readFileSync(join(root, 'owned'), 'utf8')).toBe('owned');
});

test('N2 untouched conflict aborts to exact C, then verifies only clean exact corrected source', async () => {
  const { root, tip: base, request } = fixture();
  const owner = { namespace: 'refs/saivage/conflict', card_id: 'card-a' };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'tracked'), 'C\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'C');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'private');
  writeFileSync(join(root, 'tracked'), 'P\n');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'P');
  const parent = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const result = (await argvStep({
    ...request,
    step: 'enter',
    expected: parent,
    owner,
    invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: null },
  }));
  expect(result.kind).toBe('correction-required');
  if (result.kind !== 'correction-required') throw new Error(JSON.stringify(result));
  expect(result.effects).toEqual(['checkout-completed', 'original-retained', 'rebase-aborted']);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(root, 'tracked'), 'utf8')).toBe('C\n');
  const verify = {
    ...request,
    step: 'verifyCorrection' as const,
    expected: { branch_ref: names.branch_ref, observed_tip: original },
    task: result.task,
  };
  expect((await argvStep(verify)).kind).toBe('refused');
  // Scripted correction uses the real native operation, not helper replay.
  const replay = spawnSync('git', ['rebase', '--onto', parent.observed_tip, base], {
    cwd: root,
    env: process.env,
    timeout: 5000,
  });
  expect(replay.status).toBe(1);
  writeFileSync(join(root, 'tracked'), 'P and C\n');
  git(root, 'add', 'tracked');
  const continued = spawnSync('git', ['rebase', '--continue'], {
    cwd: root,
    env: { ...process.env, GIT_EDITOR: 'true' },
    timeout: 5000,
  });
  expect(continued.status).toBe(0);
  const current = { branch_ref: names.branch_ref, observed_tip: git(root, 'rev-parse', 'HEAD') };
  expect((await argvStep({ ...verify, expected: current }))).toMatchObject({
    kind: 'correction-verified',
    effects: [],
    base_oid: parent.observed_tip,
  });
  writeFileSync(join(root, 'tracked'), 'dirty after correction');
  expect((await argvStep({ ...verify, expected: current })).kind).toBe('refused');
});

test('N2 reopened delivery replays only work beyond the last delivered child endpoint', async () => {
  const { root, tip: base, request } = fixture();
  const owner = { namespace: 'refs/saivage/delivered', card_id: 'card-b' };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'tracked'), 'already delivered');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'delivered child');
  const delivered = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'followup'), 'new child work');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'followup');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'private');
  writeFileSync(join(root, 'tracked'), 'parent revised after delivery');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'later parent');
  const parent = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const entered = (await argvStep({
    ...request,
    step: 'enter',
    expected: parent,
    owner,
    invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: delivered },
  }));
  expect(entered.kind).toBe('entered');
  expect(git(root, 'rev-list', '--count', `${parent.observed_tip}..HEAD`)).toBe('1');
  expect(readFileSync(join(root, 'tracked'), 'utf8')).toBe('parent revised after delivery');
  expect(readFileSync(join(root, 'followup'), 'utf8')).toBe('new child work');
});

test('N2 hook-affected conflict is contained without abort, replay or correction certification', async () => {
  const { root, tip: base, request } = fixture();
  const owner = { namespace: 'refs/saivage/hook', card_id: 'card-a' };
  const invocation_id = randomUUID();
  const names = nativeGitRefs(owner, invocation_id);
  git(root, 'switch', '-c', names.branch_ref.slice(11));
  writeFileSync(join(root, 'tracked'), 'C');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'C');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', 'private');
  writeFileSync(join(root, 'tracked'), 'P');
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'P');
  const parent = { branch_ref: 'refs/heads/private', observed_tip: git(root, 'rev-parse', 'HEAD') };
  const hook = join(root, '.git', 'hooks', 'pre-rebase');
  writeFileSync(hook, '#!/bin/sh\nprintf hook > hook-output\n');
  chmodSync(hook, 0o755);
  const result = (await argvStep({
    ...request,
    step: 'enter',
    expected: parent,
    owner,
    invocation_id,
    previous: { base_oid: base, observed_tip: original, last_delivered_child_tip: null },
  }));
  expect(result.kind).toBe('uncertain');
  expect(result.effects).toEqual(['checkout-completed', 'original-retained']);
  expect(readFileSync(join(root, 'hook-output'), 'utf8')).toBe('hook');
  expect(git(root, 'ls-files', '--unmerged')).not.toBe('');
  expect(git(root, 'rev-parse', names.retention_ref)).toBe(original);
});
Object.assign(process.env, identity);
afterAll(() => {
  for (const [key, value] of Object.entries(priorIdentity)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    env: { ...process.env, ...identity },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Fixture Git failed: ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'source-'));
  git(root, 'init', '--initial-branch=main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\ncache/\n');
  writeFileSync(join(root, 'tracked'), 'base\n');
  writeFileSync(join(root, 'deleted'), 'delete me\n');
  writeFileSync(join(root, 'executable'), 'program\n');
  symlinkSync('tracked', join(root, 'link'));
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture base');
  const tip = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-c', 'private');
  const request: NativeGitRequest = {
    step: 'checkpoint',
    project_root: root,
    timeout_ms: 10000,
    source: { source_roots: ['.'], excluded_paths: ['.git', '.saivage', 'excluded'] },
    expected: { branch_ref: 'refs/heads/private', observed_tip: tip },
  };
  return { root, tip, request };
}

test('commission creates only the root private ref and records bootstrap provenance without leaving delivery', async () => {
  const { root, tip, request } = fixture();
  const invocation_id = randomUUID();
  const owner = { namespace: 'refs/saivage/bootstrap', card_id: 'project' };
  const branch_ref = nativeGitRefs(owner, invocation_id).branch_ref;
  const commissioned = await argvStep({ ...request, step: 'commission', owner, invocation_id });
  expect(commissioned).toEqual({ kind: 'commissioned', source: { branch_ref, observed_tip: tip },
    parent: request.expected, effects: ['branch-created'] });
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe(request.expected.branch_ref);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(tip);
  expect(git(root, 'rev-parse', branch_ref)).toBe(tip);
  const rows = readCardExecutions(root, 'project');
  expect(rows.find(row => row.kind === 'native_started')).toMatchObject({
    step: 'commission', binding: { origin: 'bootstrap' } });
  expect(rows.at(-1)).toMatchObject({ kind: 'native_finished', outcome: 'commissioned',
    source_return: 'not_returned', facts: { base_oid: tip, source: { branch_ref, observed_tip: tip }, parent: request.expected } });
  const collision = await argvStep({ ...request, step: 'commission', owner, invocation_id: randomUUID() });
  expect(collision.kind).toBe('refused');
  expect(git(root, 'rev-parse', branch_ref)).toBe(tip);
});

test('commission refuses dirty delivery without allocating a private ref', async () => {
  const { root, request } = fixture();
  writeFileSync(join(root, 'tracked'), 'not commissioned\n');
  const owner = { namespace: 'refs/saivage/bootstrap', card_id: 'project' };
  const invocation_id = randomUUID();
  expect(await argvStep({ ...request, step: 'commission', owner, invocation_id })).toMatchObject({ kind: 'refused', effects: [] });
  expect(spawnSync('git', ['show-ref', '--verify', '--quiet', nativeGitRefs(owner, invocation_id).branch_ref],
    { cwd: root, timeout: 5000 }).status).toBe(1);
});

test('real index checkpoints final bytes/deletions/modes/symlinks and switches actual files', async () => {
  const { root, tip, request } = fixture();
  writeFileSync(join(root, 'tracked'), 'staged intermediate\n');
  git(root, 'add', 'tracked');
  writeFileSync(join(root, 'tracked'), 'final\n');
  writeFileSync(join(root, 'new'), 'new bytes\n');
  unlinkSync(join(root, 'deleted'));
  chmodSync(join(root, 'executable'), 0o755);
  unlinkSync(join(root, 'link'));
  symlinkSync('new', join(root, 'link'));
  const result = (await argvStep(request));
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
  expect(result.effects).toEqual(['index-normalized', 'commit-completed']);
  expect(git(root, 'show', 'HEAD:tracked')).toBe('final');
  expect(git(root, 'show', 'HEAD:new')).toBe('new bytes');
  expect(git(root, 'ls-tree', 'HEAD', 'deleted')).toBe('');
  expect(git(root, 'ls-tree', 'HEAD', 'executable')).toMatch(/^100755 /);
  expect(git(root, 'ls-tree', 'HEAD', 'link')).toMatch(/^120000 /);
  expect(readlinkSync(join(root, 'link'))).toBe('new');
  // Requests carry only selections, not observational extras.
  const expected = {
    branch_ref: result.observation.branch_ref,
    observed_tip: result.observation.observed_tip,
  };
  expect((await argvStep({ ...request, expected }))).toMatchObject({
    kind: 'completed',
    effects: [],
  });
  const switched = (await argvStep({
    ...request,
    step: 'switch',
    expected,
    target: { branch_ref: 'refs/heads/main', observed_tip: tip },
  }));
  expect(switched).toMatchObject({ kind: 'completed', effects: ['checkout-completed'] });
  expect(readFileSync(join(root, 'tracked'), 'utf8')).toBe('base\n');
  expect(readFileSync(join(root, 'deleted'), 'utf8')).toBe('delete me\n');
  expect(readlinkSync(join(root, 'link'))).toBe('tracked');
  expect(git(root, 'status', '--porcelain')).toBe('');
});

test('excluded/nonignored dirt and dirty protected switches refuse before mutation', async () => {
  const { root, tip, request } = fixture();
  mkdirSync(join(root, 'excluded'));
  writeFileSync(join(root, 'excluded', 'private'), 'not source');
  expect((await argvStep(request))).toMatchObject({ kind: 'refused', effects: [] });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(tip);
  expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  unlinkSync(join(root, 'excluded', 'private'));
  writeFileSync(join(root, 'tracked'), 'dirty');
  expect(
    (await argvStep({
      ...request,
      step: 'switch',
      target: { branch_ref: 'refs/heads/main', observed_tip: tip },
    })),
  ).toMatchObject({ kind: 'refused', effects: [] });
  expect(git(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/private');
  expect((await argvStep({ ...request, step: 'inspect', require_clean: true }))).toMatchObject({
    kind: 'refused',
    effects: [],
  });
});

test('owned linear commits remain valid; tracked exclusions and ignored checkout collisions never overwrite source', async () => {
  const { root, request } = fixture();
  writeFileSync(join(root, 'tracked'), 'owned commit');
  git(root, 'add', 'tracked');
  git(root, 'commit', '-m', 'owned change');
  expect((await argvStep(request))).toMatchObject({ kind: 'completed', effects: [] });
  mkdirSync(join(root, 'excluded'));
  writeFileSync(join(root, 'excluded', 'private'), 'private');
  git(root, 'add', 'excluded/private');
  expect((await argvStep(request))).toMatchObject({ kind: 'refused', effects: [] });

  const other = fixture();
  git(other.root, 'switch', 'main');
  mkdirSync(join(other.root, 'cache'));
  writeFileSync(join(other.root, 'cache', 'collision'), 'target tracked');
  // Explicit fixture input is nonignored when initially committed.
  writeFileSync(join(other.root, '.gitignore'), '.saivage/\n');
  git(other.root, 'add', '--all');
  git(other.root, 'commit', '-m', 'target file');
  const target = git(other.root, 'rev-parse', 'HEAD');
  git(other.root, 'switch', 'private');
  mkdirSync(join(other.root, 'cache'), { recursive: true });
  writeFileSync(join(other.root, 'cache', 'collision'), 'ignored valuable bytes');
  const refused = (await argvStep({
    ...other.request,
    step: 'switch',
    target: { branch_ref: 'refs/heads/main', observed_tip: target },
  }));
  expect(refused.kind).not.toBe('completed');
  expect(refused.effects).toEqual([]);
  expect(readFileSync(join(other.root, 'cache', 'collision'), 'utf8')).toBe(
    'ignored valuable bytes',
  );
  expect(git(other.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/private');
});
