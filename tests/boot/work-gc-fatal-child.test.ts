import { afterEach, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('real MCP failed startup cleanup uncertainty exits at ingress before HTTP error or response', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-gc-fatal-')); roots.push(root);
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/mcp-gc-fatal.ts', root],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000, killSignal: 'SIGKILL' });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(1);
  expect(child.stdout).toBe(''); expect(child.stderr).toContain('Fatal: PublicationOutcomeUnknownError');
  expect(child.stderr).toContain('MCP cleanup uncertain');
  expect(readFileSync(join(root, 'marker'), 'utf8')).toBe('request\ncontainment\n');
}, 25_000);
it.each(['unlink', 'fsync'])('real HTTP GC %s uncertainty exits before response, descriptor cleanup or admission release', mode => {
  const root = mkdtempSync(join(tmpdir(), 'work-gc-fatal-')); roots.push(root);
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/work-gc-fatal.ts', root, mode],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20_000, killSignal: 'SIGKILL' });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('Fatal: PublicationOutcomeUnknownError');
  expect(child.stderr).toContain(mode === 'unlink' ? 'GC unlink uncertain' : 'GC directory fsync uncertain');
  expect(readFileSync(join(root, 'marker'), 'utf8')).toBe(mode === 'unlink' ? 'request\nunlink\n' : 'request\nunlink\nfsync\n');
  // Only the parent observes the uncertain candidate; the child cannot read back.
  expect(existsSync(join(root, '.saivage/work/cards/project/tmp/disposable'))).toBe(mode === 'unlink');
}, 25_000);
