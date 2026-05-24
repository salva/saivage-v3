import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, readFileSync, readdirSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree, isInitialized, listDiscardedSaivageDirs, writeFileAtomic } from '../../src/persistence/file-tree.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
    const config = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8'),
    );
    expect(config.id).toBe('project');
    expect(typeof config.name).toBe('string');
    expect(config.max_goal_depth).toBe(5);
    expect(config.planner_enabled).toBe(true);
    expect(config.context).toBe('');
    expect(Array.isArray(config.constraints)).toBe(true);
    expect(config.created_at).toBeDefined();
    expect(config.updated_at).toBeDefined();
  });

  it('creates the project card at cards/by-id/project.json', () => {
    initProjectTree(tmpDir);
    const card = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'), 'utf-8'),
    );
    expect(card.id).toBe('project');
    expect(card.type).toBe('project');
    expect(card.parent).toBeNull();
    expect(card.depth).toBe(0);
    expect(card.status).toBe('backlog');
    expect(card.title).toBe('project');
    expect(card.created_by).toBe('analyst');
    expect(card.version_seq).toBe(1);
    expect(card.retries).toBe(0);
    expect(card.artifacts).toEqual([]);
    expect(card.attachments).toEqual([]);
    expect(card.depends_on).toEqual([]);
    expect(card.blocks).toEqual([]);
    expect(card.related).toEqual([]);
    expect(card.tags).toEqual([]);
  });

  it('creates notes/queue.json with empty entries and next sequence', () => {
    initProjectTree(tmpDir);
    const queue = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'notes', 'queue.json'), 'utf-8'),
    );
    expect(queue).toEqual({ next_note_sequence: 1, entries: [] });
  });

  it('creates views/leaderboard.json as empty array', () => {
    initProjectTree(tmpDir);
    const lb = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'views', 'leaderboard.json'), 'utf-8'),
    );
    expect(lb).toEqual([]);
  });

  it('creates views/saved-filters.json as empty array', () => {
    initProjectTree(tmpDir);
    const sf = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'views', 'saved-filters.json'), 'utf-8'),
    );
    expect(sf).toEqual([]);
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
      readFileSync(
        join(tmpDir, '.saivage', 'supervision', 'quarantine-index.json'),
        'utf-8',
      ),
    );
    expect(qi).toEqual([]);
  });

  it('creates all .saivage/ directories', () => {
    initProjectTree(tmpDir);
    const saivageDirs = [
      'skills',
      'cards/by-id',
      'cards/history',
      'cards/.commit',
      'diaries',
      'reviews/by-goal',
      'notes/by-card',
      'agents/sessions',
      'agents/messages',
      'runtime',
      'supervision',
      'views',
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
    const cardBefore = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'),
      'utf-8',
    );
    const configBefore = readFileSync(
      join(tmpDir, '.saivage', 'project.json'),
      'utf-8',
    );

    initProjectTree(tmpDir);

    const cardAfter = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'),
      'utf-8',
    );
    const configAfter = readFileSync(
      join(tmpDir, '.saivage', 'project.json'),
      'utf-8',
    );

    expect(cardAfter).toBe(cardBefore);
    expect(configAfter).toBe(configBefore);
    expect(listDiscardedSaivageDirs(tmpDir)).toEqual([]);
  });

  it('does not create duplicate project cards on repeated calls', () => {
    initProjectTree(tmpDir);
    initProjectTree(tmpDir);
    initProjectTree(tmpDir);

    const card = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'), 'utf-8'),
    );
    expect(card.id).toBe('project');
  });

  it('discards legacy .saivage layouts and creates a fresh tree', () => {
    const legacyDir = join(tmpDir, '.saivage');
    mkdirSync(join(legacyDir, 'runtime'), { recursive: true });
    writeFileSync(join(legacyDir, 'runtime', 'state.json'), JSON.stringify({ status: 'running' }, null, 2));
    writeFileSync(join(legacyDir, 'old-layout.json'), '{"legacy":true}');

    initProjectTree(tmpDir);

    const discarded = listDiscardedSaivageDirs(tmpDir);
    expect(discarded).toHaveLength(1);
    expect(existsSync(join(tmpDir, discarded[0], 'old-layout.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(tmpDir, '.saivage', 'project.json'), 'utf-8')).id).toBe('project');
  });

  it('keeps already-new .saivage state instead of discarding it', () => {
    initProjectTree(tmpDir);
    const sentinelPath = join(tmpDir, '.saivage', 'runtime', 'events.jsonl');
    writeFileSync(sentinelPath, 'sentinel-event\n');

    initProjectTree(tmpDir);

    expect(listDiscardedSaivageDirs(tmpDir)).toEqual([]);
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('sentinel-event\n');
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
