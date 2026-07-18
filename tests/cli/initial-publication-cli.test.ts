import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';

import { run } from '../../src/cli.js';
import { readCard } from '../../src/persistence/card-files.js';
import { resetOwnedGeneratedRoots } from '../../src/persistence/layout.js';
import { createProjectIdentity, readProjectIdentity } from '../../src/persistence/project-identity.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

const roots: string[] = [];
const originalCwd = process.cwd();

function projectRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeFixture(root: string, relativePath: string, bytes: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function writeValidConfig(root: string): void {
  writeFixture(root, '.saivage/saivage.yaml', YAML.stringify({
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { models: ['test-model'] } },
    compaction: {
      enabled: true,
      input_budget_tokens: 1000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
    card_processes: DEFAULT_CARD_PROCESSES,
    runtime: { continuous_improvement: false },
    server: { host: '127.0.0.1', port: 8080 },
  }));
}

async function runFrom(root: string, command: string, ...args: string[]): Promise<void> {
  process.chdir(root);
  await run(['node', 'saivage', command, ...args]);
}

afterEach(() => {
  process.chdir(originalCwd);
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('CLI initial project-card publication boundary', () => {
  it('initializes fresh state and leaves valid initialized canonical bytes unchanged on a second init', async () => {
    const root = projectRoot('saivage-initial-publication-fresh-');
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await runFrom(root, 'init');
    const cardPath = join(root, '.saivage', 'cards', 'project', 'card.jsonl');
    const briefPath = join(root, '.saivage', 'cards', 'project', 'brief.jsonl');
    const cardBytes = readFileSync(cardPath);
    const briefBytes = readFileSync(briefPath);
    expect(readCard(root, 'project')).toMatchObject({ id: 'project', type: 'project', version_seq: 1 });

    await runFrom(root, 'init');
    expect(readFileSync(cardPath)).toEqual(cardBytes);
    expect(readFileSync(briefPath)).toEqual(briefBytes);
  });

  it.each([
    ['cards', '.saivage/cards/retained.bin'],
    ['agents', '.saivage/agents/retained.bin'],
    ['logs', '.saivage/logs/retained.bin'],
    ['work', '.saivage/work/retained.bin'],
  ])('rejects retained %s state without creating another generated root', async (_name, markerRelative) => {
    const root = projectRoot('saivage-initial-publication-partial-');
    createProjectIdentity(root, 'partial-state-test');
    const marker = writeFixture(root, markerRelative, `retained:${markerRelative}\0`);
    const before = resetOwnedGeneratedRoots(root).map((path) => existsSync(path));
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runFrom(root, 'init')).rejects.toThrow(
      new RegExp(`generated state exists at '${join(root, dirname(markerRelative))}`),
    );

    expect(readFileSync(marker, 'utf8')).toBe(`retained:${markerRelative}\0`);
    expect(resetOwnedGeneratedRoots(root).map((path) => existsSync(path))).toEqual(before);
  });

  it('binds a missing identity before rejecting retained state so the following reset succeeds', async () => {
    const root = projectRoot('saivage-initial-publication-resettable-');
    const marker = writeFixture(root, '.saivage/logs/retained.bin', 'retained-before-reset\0');
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runFrom(root, 'init')).rejects.toThrow(/run the current built saivage reset, and retry/);
    expect(readProjectIdentity(root)).toMatchObject({ id: 'project' });
    expect(readFileSync(marker, 'utf8')).toBe('retained-before-reset\0');
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);

    await runFrom(root, 'reset');
    expect(existsSync(marker)).toBe(false);
    expect(readCard(root, 'project')).toMatchObject({ id: 'project', type: 'project', version_seq: 1 });
  });

  it('classifies a regular file at the exact cards root before a child read', async () => {
    const root = projectRoot('saivage-initial-publication-file-');
    const cardsRoot = writeFixture(root, '.saivage/cards', 'cards-obstruction\0');
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runFrom(root, 'init')).rejects.toThrow(
      `The canonical project card cannot be newly published because generated state exists at '${cardsRoot}'.`,
    );
    expect(readFileSync(cardsRoot, 'utf8')).toBe('cards-obstruction\0');
    expect(existsSync(join(root, '.saivage', 'agents'))).toBe(false);
  });

  it('rejects a symlink at the exact cards root without following or changing it', async () => {
    const root = projectRoot('saivage-initial-publication-symlink-');
    const target = join(root, 'cards-link-target');
    mkdirSync(target);
    const marker = writeFixture(root, 'cards-link-target/retained.bin', 'linked-target-marker\0');
    mkdirSync(join(root, '.saivage'));
    const cardsRoot = join(root, '.saivage', 'cards');
    symlinkSync(target, cardsRoot, 'dir');
    const linkTarget = readlinkSync(cardsRoot);
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runFrom(root, 'init')).rejects.toThrow(`generated state exists at '${cardsRoot}'`);
    expect(lstatSync(cardsRoot).isSymbolicLink()).toBe(true);
    expect(readlinkSync(cardsRoot)).toBe(linkTarget);
    expect(readFileSync(marker, 'utf8')).toBe('linked-target-marker\0');
    expect(existsSync(join(root, '.saivage', 'agents'))).toBe(false);
  });

  it('ignores arbitrary noncanonical siblings and lifecycle-lock siblings during fresh init', async () => {
    const root = projectRoot('saivage-initial-publication-siblings-');
    const sibling = writeFixture(root, '.saivage/operator-owned.bin', 'operator-owned\0');
    const lockSibling = writeFixture(root, '.saivage/locks/arbitrary.bin', 'lock-sibling\0');
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await runFrom(root, 'init');

    expect(readCard(root, 'project')).toMatchObject({ id: 'project' });
    expect(readFileSync(sibling, 'utf8')).toBe('operator-owned\0');
    expect(readFileSync(lockSibling, 'utf8')).toBe('lock-sibling\0');
  });

  it('rejects the removed init --force option', async () => {
    const root = projectRoot('saivage-initial-publication-force-');
    await expect(runFrom(root, 'init', '--force')).rejects.toThrow(/Unknown option '--force'/);
  });

  it('rejects an exact cards-root file during valid-config start --create-runtime and releases the lock', async () => {
    const root = projectRoot('saivage-initial-publication-start-file-');
    createProjectIdentity(root, 'start-obstruction-test');
    writeValidConfig(root);
    const cardsRoot = writeFixture(root, '.saivage/cards', 'start-cards-obstruction\0');

    await expect(runFrom(root, 'start', '--project-root', root, '--create-runtime')).rejects.toThrow(
      `generated state exists at '${cardsRoot}'`,
    );

    expect(readFileSync(cardsRoot, 'utf8')).toBe('start-cards-obstruction\0');
    expect(existsSync(join(root, '.saivage', 'locks', 'runtime.lock'))).toBe(false);
  });
});
