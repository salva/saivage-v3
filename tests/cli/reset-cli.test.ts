import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '../../src/cli.js';
import { readCard } from '../../src/persistence/card-files.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { acquireRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';

const generatedDescendants = [
  'cards/project/card/versions/marker.bin',
  'cards/.orphan-random/nested/marker.bin',
  'agents/conversations/session/marker.bin',
  'agents/.orphan-random/nested/marker.bin',
  'logs/app.jsonl',
  'logs/.orphan-random/nested/marker.bin',
  'work/cards/card/processes/process/marker.bin',
  'work/.orphan-random/nested/marker.bin',
] as const;
const roots: string[] = [];
const originalCwd = process.cwd();

function createInitializedProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  createProjectIdentity(root, 'Reset CLI test');
  return root;
}

function writeFixture(root: string, relativePath: string, bytes: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function generatedMarkers(root: string): string[] {
  return generatedDescendants.map((path) => join(root, '.saivage', path));
}

function seedGeneratedMarkers(root: string): string[] {
  const markers = generatedMarkers(root);
  for (const marker of markers) {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `generated:${marker}\0`);
  }
  return markers;
}

afterEach(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('CLI reset generated-root boundary', () => {
  it('removes the four generated roots wholesale, republishes the root card, and preserves everything outside them', async () => {
    const root = createInitializedProject('saivage-reset-cli-');
    const markers = seedGeneratedMarkers(root);
    const preserved = new Map<string, string>([
      ['.saivage/saivage.yaml', 'models: []\n'],
      ['.saivage/auth-profiles.json', '{"profiles":[]}\n'],
      ['.saivage/project.json', readFileSync(join(root, '.saivage', 'project.json'), 'utf8')],
      ['.saivage/config/prompts/project/analyst.md', '# operator prompt\n'],
      ['.saivage/skills/index.json', '{"skills":[]}\n'],
      ['.saivage/instructions/analyst.md', '# operator instruction\n'],
      ['.saivage/operator-owned.bin', 'unknown-saivage-sibling\0'],
      ['operator-owned.bin', 'unknown-project-sibling\0'],
      ['src/main.ts', 'export const preserved = true;\n'],
      ['docs/SPEC.md', '# Preserved specification\n'],
      ['.saivage/locks/arbitrary-sibling.bin', 'untouched-lock-sibling\0'],
    ]);
    for (const [path, bytes] of preserved) writeFixture(root, path, bytes);

    process.chdir(root);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await run(['node', 'saivage', 'reset']);

    for (const marker of markers) expect(existsSync(marker)).toBe(false);
    expect(readCard(root, 'project')).toMatchObject({ id: 'project', type: 'project', parent: null, version_seq: 1 });
    for (const [path, bytes] of preserved) expect(readFileSync(join(root, path), 'utf8')).toBe(bytes);
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
    for (const name of ['agents', 'logs', 'work']) expect(existsSync(join(root, '.saivage', name))).toBe(false);
  });

  it('does not delete generated state when a live exact lifecycle lock blocks acquisition', async () => {
    const root = createInitializedProject('saivage-reset-live-lock-');
    const markers = seedGeneratedMarkers(root);
    const lock: RuntimeLifecycleLockHandle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    process.chdir(root);
    try {
      await expect(run(['node', 'saivage', 'reset'])).rejects.toThrow(/Runtime lock is held by live PID/);
      for (const marker of markers) expect(readFileSync(marker, 'utf8')).toContain('generated:');
    } finally {
      releaseRuntimeLifecycleLock(lock);
    }
  });

  it('does not delete generated state when a malformed exact lifecycle lock blocks acquisition', async () => {
    const root = createInitializedProject('saivage-reset-malformed-lock-');
    const markers = seedGeneratedMarkers(root);
    writeFixture(root, '.saivage/locks/runtime.lock', '{malformed');
    process.chdir(root);

    await expect(run(['node', 'saivage', 'reset'])).rejects.toThrow(/Runtime lock is malformed/);
    for (const marker of markers) expect(readFileSync(marker, 'utf8')).toContain('generated:');
    expect(readFileSync(join(root, '.saivage', 'locks', 'runtime.lock'), 'utf8')).toBe('{malformed');
  });
});
