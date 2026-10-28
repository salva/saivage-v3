import { afterEach, expect, it } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree, CardService } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { acquireRuntimeLifecycleLock, readRuntimeLockStatus, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';
import { appendCardExecutions } from '../../src/persistence/card-execution-log.js';
import { cardExecutionFile, runtimeProcessLockFile, globalAgentConversationVersionIndexFile, globalAgentConversationVersionFile, projectIdentityFile, cardRecordHeadFile } from '../../src/persistence/layout.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { buildGlobalAgentIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { appendStartupPendingCall } from '../helpers/startup-session-fixtures.js';
import { publicNativeCli, nativeOptions, fixtureGit } from '../helpers/public-native-project.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gc-offline-')); roots.push(root);
  initProjectTree(root);
  createTestConfigAuthority(root, { relativePath: '.saivage/saivage.yaml' });
  return root;
}
function work(root: string, path: string) {
  const full = join(root, '.saivage/work', path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, 'fixture'); return full;
}
async function cli(root: string, options: { delete?: boolean; phrase?: string; eof?: boolean; fault?: boolean; beforeAck?: () => void; onLock?: (pid: number) => void } = {}) {
  const entry = resolve(options.fault ? 'tests/fixtures/offline-gc-child.ts' : 'src/cli.ts');
  const command = [process.execPath, '--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, ...(options.fault ? [] : ['gc-work', ...(options.delete ? ['--delete'] : [])])].map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', sent = false, lockObserved = false;
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const observe = setInterval(() => {
    if (!options.onLock || lockObserved || !existsSync(runtimeProcessLockFile(root))) return;
    const status = readRuntimeLockStatus(root);
    if (status.kind !== 'live') return;
    lockObserved = true;
    expect(status.record.lock_state).toBe('bound'); expect(status.record.control_endpoint).toBeNull();
    options.onLock(status.record.pid);
  }, 1);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (!sent && output.includes('to confirm:')) { sent = true; options.beforeAck?.(); child.stdin.write(options.eof ? '\u0004' : `${options.phrase ?? `GC OFFLINE QUIESCENT ${root}`}\n`); }
  });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    const row = output.split(/\r?\n/).find(line => line.startsWith('{"mode":'));
    return { code, output, response: row ? JSON.parse(row) : null, lockObserved };
  } finally { clearInterval(observe); clearTimeout(watchdog); }
}

it('real offline preview and fresh delete preserve running/unmatched/native selections without replay', async () => {
  const root = fixture();
  new CardService(root).setStatus('project', 'running');
  const input = randomUUID(), session = 'agent:analyst:global' as const;
  appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(session, input, 'interrupted', { kind: 'unavailable', reason: 'not_recorded' }));
  appendStartupPendingCall(root, session, input);
  const segment = readCurrentConversationSegment(root, session)!;
  const invocation = randomUUID(), processId = 'proc-0123456789ab';
  const indexRelative = `.saivage/work/cards/project/tmp/native-git-${invocation}/index`;
  const index = work(root, indexRelative.slice('.saivage/work/'.length));
  const captures = ['stdout', 'stderr'].map(s => work(root, `cards/project/processes/${processId}/${s}.log`));
  appendCardExecutions(root, 'project', [
    { row_id: randomUUID(), invocation_id: invocation, card_id: 'project', timestamp: '2026-10-27T00:00:00.000Z', kind: 'native_started', step: 'captureRebase', binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null, node: { node_id: 'git-rebase-correction', ordinal: 1 } }, artifact_paths: [indexRelative] },
    { row_id: randomUUID(), invocation_id: invocation, card_id: 'project', timestamp: '2026-10-27T00:00:00.000Z', kind: 'native_process_started', process_id: processId, allowed_exit_codes: [0], files: (['stdout', 'stderr'] as const).map(stream => ({ kind: 'capture', stream, path: `.saivage/work/cards/project/processes/${processId}/${stream}.log` })) },
  ]);
  const garbage = work(root, 'cards/project/tmp/unselected');
  const selected = [index, ...captures, cardExecutionFile(root, 'project'), join(root, '.saivage/cards/project/card-head.json'), globalAgentConversationVersionIndexFile(root, 'analyst')].map(path => [path, readFileSync(path)] as const);
  const preview = await cli(root);
  expect(preview).toMatchObject({ code: 0, response: { disposition: 'completed', restoration: 'not_resumed' } });
  expect(existsSync(runtimeProcessLockFile(root))).toBe(false); expect(existsSync(garbage)).toBe(true);
  const deletion = await cli(root, { delete: true });
  expect(deletion).toMatchObject({ code: 0, response: { disposition: 'completed', restoration: 'not_resumed' } });
  expect(deletion.response.result.deleted_count).toBe(1); expect(existsSync(garbage)).toBe(false);
  for (const [path, bytes] of selected) expect(readFileSync(path)).toEqual(bytes);
  expect(readCurrentConversationSegment(root, session)).toEqual(segment);
}, 45_000);

it('holds bound exclusion across inventory yields; a second owner refuses and cancellation settles before release', async () => {
  const root = fixture(); for (let n = 0; n < 4000; n++) work(root, `cards/project/tmp/item-${n}`);
  const result = await cli(root, { onLock(pid) {
    expect(() => acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' })).toThrow('live PID');
    process.kill(pid, 'SIGINT');
  } });
  expect(result.lockObserved).toBe(true);
  expect(result).toMatchObject({ code: 1, response: { reason: 'cancelled', restoration: 'not_resumed' } });
  expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  expect(existsSync(join(root, '.saivage/work/cards/project/tmp/item-3999'))).toBe(true);
}, 30_000);

it('a second real CLI owner cannot initialize under bound null-endpoint exclusion', () => {
  const root = fixture(), lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
  try {
    const second = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli.ts'), 'init'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(second.status).toBe(1); expect(second.stderr).toContain('live PID');
    expect(readRuntimeLockStatus(root).kind).toBe('live');
  } finally { releaseRuntimeLifecycleLock(lock); }
}, 15_000);

it('losing acquisition after acknowledgement refuses without reroute, takeover or release of the winner', async () => {
  const root = fixture(); let winner: ReturnType<typeof acquireRuntimeLifecycleLock> | undefined;
  try {
    const result = await cli(root, { beforeAck() { winner = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' }); } });
    expect(result.code).toBe(1); expect(result.response).toBeNull(); expect(result.output).toContain('live PID');
    expect(readRuntimeLockStatus(root).kind).toBe('live');
  } finally { if (winner) releaseRuntimeLifecycleLock(winner); }
}, 30_000);

it('offline native project retains commissioned captures and never changes delivery source, refs or Git index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-offline-native-')); roots.push(root);
  fixtureGit(root, 'init', '-b', 'main'); writeFileSync(join(root, '.gitignore'), '.saivage/\n'); writeFileSync(join(root, 'source.txt'), 'delivery\n');
  fixtureGit(root, 'add', '--all'); fixtureGit(root, 'commit', '-m', 'Fixture delivery');
  expect(publicNativeCli(root, 'init', ...nativeOptions).status).toBe(0);
  const selected = [join(root, '.git/HEAD'), join(root, '.git/index'), join(root, 'source.txt'), cardExecutionFile(root, 'project'), join(root, '.saivage/cards/project/card-head.json')].map(path => [path, readFileSync(path)] as const);
  const oid = fixtureGit(root, 'rev-parse', 'main'), garbage = work(root, 'cards/project/tmp/unselected');
  const result = await cli(root, { delete: true });
  expect(result).toMatchObject({ code: 0, response: { disposition: 'completed' } }); expect(result.response.result.deleted_count).toBe(1); expect(existsSync(garbage)).toBe(false);
  for (const [path, bytes] of selected) expect(readFileSync(path)).toEqual(bytes);
  expect(fixtureGit(root, 'rev-parse', 'main')).toBe(oid);
}, 45_000);

it('refuses wrong acknowledgement before publishing a lock or reading malformed config', async () => {
  const root = fixture(); writeFileSync(join(root, '.saivage/saivage.yaml'), 'malformed: [');
  const result = await cli(root, { phrase: 'unknown writers' });
  expect(result.code).toBe(1); expect(result.output).toContain('acknowledgement refused'); expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
}, 30_000);

it('EOF and noninteractive input refuse without acquiring exclusion', async () => {
  const root = fixture();
  const eof = await cli(root, { eof: true });
  expect(eof.code).toBe(1); expect(eof.response).toBeNull(); expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  const unattended = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli.ts'), 'gc-work'], { cwd: root, encoding: 'utf8', input: `GC OFFLINE QUIESCENT ${root}\n`, timeout: 10_000 });
  expect(unattended.status).toBe(1); expect(unattended.stderr).toContain('interactive'); expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
}, 30_000);

it.each(['identity', 'bootstrap', 'malformed', 'torn'] as const)('offline %s failure remains strict without repair or initialization', async (fault) => {
  const root = fixture();
  let path: string;
  if (fault === 'identity') { path = projectIdentityFile(root); unlinkSync(path); }
  else if (fault === 'bootstrap') { path = cardRecordHeadFile(root, 'project', { filename: 'brief.md' }); unlinkSync(path); }
  else {
    appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows('agent:analyst:global', randomUUID(), 'fixture', { kind: 'unavailable', reason: 'not_recorded' }));
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename);
    writeFileSync(path, fault === 'torn' ? '{"torn":' : '{"malformed":true}\n');
  }
  const bytes = existsSync(path) ? readFileSync(path) : null;
  const result = await cli(root);
  expect(result.code).toBe(1); expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  if (bytes) expect(readFileSync(path)).toEqual(bytes); else expect(existsSync(path)).toBe(false);
}, 30_000);

it('strict missing selected index fails without initialization or recovery and releases exclusion', async () => {
  const root = fixture(), path = globalAgentConversationVersionIndexFile(root, 'analyst'); unlinkSync(path);
  const result = await cli(root);
  expect(result).toMatchObject({ code: 1, response: { disposition: 'refused', restoration: 'not_resumed' } });
  expect(existsSync(path)).toBe(false); expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
}, 30_000);

it('real offline child release uncertainty exits fatally without response or prompt cleanup', async () => {
  const root = fixture(); work(root, 'cards/project/tmp/unselected');
  const result = await cli(root, { fault: true });
  expect(result.code).toBe(1); expect(result.response).toBeNull();
  expect(result.output).toContain('RELEASE_UNCERTAIN'); expect(result.output).toContain('Fatal: PublicationOutcomeUnknownError');
  expect(result.output).not.toContain('FORBIDDEN_'); expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
}, 30_000);
