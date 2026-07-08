import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initProjectTree,
  isInitialized,
} from '../../src/persistence/file-tree.js';
import { writeFileAtomic } from '../../src/persistence/durable-write.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function listDiscardedSaivageDirs(projectRoot: string): string[] {
  return existsSync(projectRoot)
    ? readdirSync(projectRoot).filter((entry) => entry.startsWith('.saivage.discarded-'))
    : [];
}

function listDiscardedSaivageWorkDirs(projectRoot: string): string[] {
  return existsSync(projectRoot)
    ? readdirSync(projectRoot).filter((entry) => entry.startsWith('.saivage-work.discarded-'))
    : [];
}

function discardStamp(name: string, prefix: string): string {
  return name.slice(prefix.length);
}

function seedPostStage1RequiredLegacyState(projectRoot: string): void {
  const legacyDir = join(projectRoot, '.saivage');
  mkdirSync(join(legacyDir, 'outputs', 'cards'), { recursive: true });
  mkdirSync(join(legacyDir, 'agents', 'conversations'), { recursive: true });
  mkdirSync(join(legacyDir, 'runtime'), { recursive: true });
  mkdirSync(join(legacyDir, 'supervision'), { recursive: true });
  mkdirSync(join(legacyDir, 'views'), { recursive: true });
  writeFileSync(join(legacyDir, 'project.json'), JSON.stringify({ id: 'project', name: 'legacy', context: '', goals_summary: '', constraints: [], planner_enabled: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }));
}

describe('isInitialized', () => {
  it('returns false before init', () => {
    expect(isInitialized(tmpDir)).toBe(false);
  });

  it('returns true after initProjectTree', () => {
    initProjectTree(tmpDir);
    expect(isInitialized(tmpDir)).toBe(true);
  });
});

describe('initProjectTree', () => {
  it('returns the project root', () => {
    const result = initProjectTree(tmpDir);
    expect(result.projectRoot).toBe(tmpDir);
  });

  it('creates project.json with valid ProjectConfig', () => {
    initProjectTree(tmpDir);
    const config = JSON.parse(readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8'));
    expect(config.id).toBe('project');
    expect(typeof config.name).toBe('string');
    expect(Object.keys(config).sort()).toEqual([
      'constraints',
      'context',
      'created_at',
      'goals_summary',
      'id',
      'name',
      'planner_enabled',
      'updated_at',
    ]);
    expect(config.planner_enabled).toBe(true);
    expect(config.context).toBe('');
    expect(Array.isArray(config.constraints)).toBe(true);
    expect(config.created_at).toBeDefined();
    expect(config.updated_at).toBeDefined();
  });

  it('starts with a canonical root project card', () => {
    initProjectTree(tmpDir);
    expect(readdirSync(join(tmpDir, '.saivage', 'outputs', 'cards')).sort()).toEqual(['index.json', 'project']);
  });

  it('does not create the legacy notes queue', () => {
    initProjectTree(tmpDir);
    expect(existsSync(join(tmpDir, '.saivage', 'notes'))).toBe(false);
  });

  it('does not create the legacy agent llm-exchanges tree', () => {
    initProjectTree(tmpDir);
    expect(existsSync(join(tmpDir, '.saivage', 'agents', 'llm-exchanges'))).toBe(false);
  });

  it('creates skills/index.json as empty array', () => {
    initProjectTree(tmpDir);
    const skills = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'skills', 'index.json'), 'utf-8'),
    );
    expect(skills).toEqual([]);
  });

  it('creates runtime/events.jsonl', () => {
    initProjectTree(tmpDir);
    expect(existsSync(join(tmpDir, '.saivage', 'runtime', 'events.jsonl'))).toBe(true);
  });

  it('creates runtime/errors.jsonl', () => {
    initProjectTree(tmpDir);
    expect(existsSync(join(tmpDir, '.saivage', 'runtime', 'errors.jsonl'))).toBe(true);
  });

  it('creates supervision/reviews.jsonl', () => {
    initProjectTree(tmpDir);
    expect(existsSync(join(tmpDir, '.saivage', 'supervision', 'reviews.jsonl'))).toBe(true);
  });

  it('creates supervision/quarantine-index.json', () => {
    initProjectTree(tmpDir);
    const qi = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'supervision', 'quarantine-index.json'), 'utf-8'),
    );
    expect(qi).toEqual([]);
  });

  it('creates all .saivage/ directories', () => {
    initProjectTree(tmpDir);
    const saivageDirs = [
      'skills',
      'outputs/cards',
      'agents/conversations',
      'runtime',
      'supervision',
      'instructions',
    ];
    for (const dir of saivageDirs) {
      expect(existsSync(join(tmpDir, '.saivage', dir))).toBe(true);
    }
  });

  it('creates all .saivage-work/ directories', () => {
    initProjectTree(tmpDir);
    const workDirs = [
      'cards',
      'processes',
      'downloads',
      'quarantine',
      'tmp/runtime',
      'tmp/stash',
      'tmp/uploads',
      'tmp/previews',
    ];
    for (const dir of workDirs) {
      expect(existsSync(join(tmpDir, '.saivage-work', dir))).toBe(true);
    }
  });

  it('is idempotent — calling twice does not change files', () => {
    initProjectTree(tmpDir);
    const cardsBefore = readdirSync(join(tmpDir, '.saivage', 'outputs', 'cards'));
    const configBefore = readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8');

    initProjectTree(tmpDir);

    const cardsAfter = readdirSync(join(tmpDir, '.saivage', 'outputs', 'cards'));
    const configAfter = readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8');

    expect(cardsAfter).toEqual(cardsBefore);
    expect(configAfter).toBe(configBefore);
    expect(listDiscardedSaivageDirs(tmpDir)).toEqual([]);
  });

  it('does not create duplicate project cards on repeated calls', () => {
    initProjectTree(tmpDir);
    initProjectTree(tmpDir);
    initProjectTree(tmpDir);

    expect(readdirSync(join(tmpDir, '.saivage', 'outputs', 'cards')).sort()).toEqual(['index.json', 'project']);
  });

  it('discards legacy .saivage layouts and creates a fresh tree', () => {
    const legacyDir = join(tmpDir, '.saivage');
    const legacyWorkDir = join(tmpDir, '.saivage-work');
    mkdirSync(join(legacyDir, 'runtime'), { recursive: true });
    mkdirSync(join(legacyWorkDir, 'processes', 'proc-legacy'), { recursive: true });
    writeFileSync(
      join(legacyDir, 'runtime', 'state.json'),
      JSON.stringify({ status: 'running' }, null, 2),
    );
    writeFileSync(join(legacyDir, 'old-layout.json'), '{"legacy":true}');
    writeFileSync(join(legacyWorkDir, 'processes', 'proc-legacy', 'combined.log'), 'combined');

    initProjectTree(tmpDir);

    const discarded = listDiscardedSaivageDirs(tmpDir);
    const discardedWork = listDiscardedSaivageWorkDirs(tmpDir);
    expect(discarded).toHaveLength(1);
    expect(discardedWork).toHaveLength(1);
    expect(existsSync(join(tmpDir, discarded[0], 'old-layout.json'))).toBe(true);
    expect(existsSync(join(tmpDir, discardedWork[0], 'processes', 'proc-legacy', 'combined.log'))).toBe(true);
    expect(discardStamp(discarded[0], '.saivage.discarded-')).toBe(discardStamp(discardedWork[0], '.saivage-work.discarded-'));
    expect(existsSync(join(tmpDir, '.saivage-work', 'processes', 'proc-legacy', 'combined.log'))).toBe(false);
    expect(JSON.parse(readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8')).id).toBe(
      'project',
    );
  });

  it('discards state containing the legacy agent llm-exchanges tree', () => {
    const legacyDir = join(tmpDir, '.saivage');
    mkdirSync(join(legacyDir, 'outputs', 'cards'), { recursive: true });
    mkdirSync(join(legacyDir, 'agents', 'conversations'), { recursive: true });
    mkdirSync(join(legacyDir, 'agents', 'llm-exchanges'), { recursive: true });
    mkdirSync(join(legacyDir, 'runtime'), { recursive: true });
    mkdirSync(join(legacyDir, 'supervision'), { recursive: true });
    writeFileSync(join(legacyDir, 'project.json'), JSON.stringify({ id: 'project', name: 'legacy', context: '', goals_summary: '', constraints: [], planner_enabled: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }));
    initProjectTree(tmpDir);
    expect(listDiscardedSaivageDirs(tmpDir)).toHaveLength(1);
    expect(existsSync(join(tmpDir, '.saivage', 'agents', 'llm-exchanges'))).toBe(false);
  });

  it('keeps already-new .saivage state instead of discarding it', () => {
    initProjectTree(tmpDir);
    const sentinelPath = join(tmpDir, '.saivage', 'runtime', 'events.jsonl');
    const workSentinelPath = join(tmpDir, '.saivage-work', 'processes', 'sentinel.txt');
    writeFileSync(sentinelPath, 'sentinel-event\n');
    writeFileSync(workSentinelPath, 'work-sentinel\n');

    initProjectTree(tmpDir);

    expect(listDiscardedSaivageDirs(tmpDir)).toEqual([]);
    expect(listDiscardedSaivageWorkDirs(tmpDir)).toEqual([]);
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('sentinel-event\n');
    expect(readFileSync(workSentinelPath, 'utf-8')).toBe('work-sentinel\n');
  });

  it('discards pre-Stage-1 .saivage-work with the paired legacy .saivage state', () => {
    seedPostStage1RequiredLegacyState(tmpDir);
    mkdirSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1', 'stdout.log'), 'stdout');
    writeFileSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1', 'combined.log'), 'combined');

    initProjectTree(tmpDir);

    const discarded = listDiscardedSaivageDirs(tmpDir);
    const discardedWork = listDiscardedSaivageWorkDirs(tmpDir);
    expect(discarded).toHaveLength(1);
    expect(discardedWork).toHaveLength(1);
    expect(discardStamp(discarded[0], '.saivage.discarded-')).toBe(discardStamp(discardedWork[0], '.saivage-work.discarded-'));
    expect(existsSync(join(tmpDir, discardedWork[0], 'processes', 'proc-1', 'combined.log'))).toBe(true);
    expect(existsSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1', 'combined.log'))).toBe(false);
  });

  it('fails fast instead of discarding legacy state while a live runtime lock is held', () => {
    seedPostStage1RequiredLegacyState(tmpDir);
    mkdirSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });
    writeFileSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1', 'combined.log'), 'combined');
    const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

    expect(() => initProjectTree(tmpDir)).toThrow(/runtime lock .*Stop the runtime first/);
    expect(listDiscardedSaivageDirs(tmpDir)).toEqual([]);
    expect(listDiscardedSaivageWorkDirs(tmpDir)).toEqual([]);
    expect(existsSync(join(tmpDir, '.saivage', 'views'))).toBe(true);
    expect(existsSync(join(tmpDir, '.saivage-work', 'processes', 'proc-1', 'combined.log'))).toBe(true);

    rmSync(lockPath);
    initProjectTree(tmpDir);
    expect(listDiscardedSaivageDirs(tmpDir)).toHaveLength(1);
    expect(listDiscardedSaivageWorkDirs(tmpDir)).toHaveLength(1);
  });
});

describe('writeFileAtomic', () => {
  it('writes content to the target file', () => {
    const targetPath = join(tmpDir, '.saivage', 'atomic-test.json');
    writeFileAtomic(targetPath, JSON.stringify({ foo: 'bar' }));
    const content = JSON.parse(readFileSync(targetPath, 'utf-8'));
    expect(content).toEqual({ foo: 'bar' });
  });

  it('creates parent directories if needed', () => {
    const targetPath = join(tmpDir, '.saivage', 'nested', 'deep', 'test.json');
    writeFileAtomic(targetPath, '{"a": 1}');
    expect(existsSync(targetPath)).toBe(true);
    const content = JSON.parse(readFileSync(targetPath, 'utf-8'));
    expect(content).toEqual({ a: 1 });
  });

  it('does not leave temp files behind', () => {
    const dir = join(tmpDir, '.saivage', 'atomic-dir');
    const targetPath = join(dir, 'final.json');
    writeFileAtomic(targetPath, 'data');

    const files = readdirSync(dir);
    const tmpFiles = files.filter((f: string) => f.startsWith('final.json.tmp'));
    expect(tmpFiles.length).toBe(0);
    expect(files).toEqual(['final.json']);
  });
});
