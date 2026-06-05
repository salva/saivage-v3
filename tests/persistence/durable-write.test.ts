import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSyncDurable } from '../../src/persistence/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-durable-write-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeFileSyncDurable', () => {
  it('writes exact text content and creates parent directories', () => {
    const targetPath = join(tmpDir, '.saivage', 'nested', 'state.json');

    writeFileSyncDurable(targetPath, JSON.stringify({ foo: 'bar' }, null, 2) + '\n');

    expect(readFileSync(targetPath, 'utf-8')).toBe('{\n  "foo": "bar"\n}\n');
  });

  it('renames over existing content without leaving temp files', () => {
    const dir = join(tmpDir, '.saivage', 'sessions');
    const targetPath = join(dir, 'session.json');

    writeFileSyncDurable(targetPath, 'old\n');
    writeFileSyncDurable(targetPath, 'new\n');

    expect(readFileSync(targetPath, 'utf-8')).toBe('new\n');
    expect(readdirSync(dir).filter((entry) => entry.startsWith('session.json.tmp.'))).toEqual([]);
  });

  it('cleans up the temp file when rename fails', () => {
    const dir = join(tmpDir, '.saivage', 'durable-dir-target');
    mkdirSync(dir, { recursive: true });

    expect(() => writeFileSyncDurable(dir, 'data')).toThrow();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(join(tmpDir, '.saivage')).filter((entry) => entry.startsWith('durable-dir-target.tmp.'))).toEqual([]);
  });
});
