import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replaceFile, replacementTempPath } from '../../src/persistence/replace-file.js';

describe('fresh-exclusive direct file replacement', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-replace-file-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('asks once for one same-directory temporary and publishes the canonical target', () => {
    const target = join(root, 'nested', 'state.json');
    mkdirSync(join(root, 'nested'));
    const factory = jest.fn<() => string>(() => '11111111-1111-4111-8111-111111111111');
    replaceFile(target, Buffer.from('current\n'), factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(readFileSync(target, 'utf8')).toBe('current\n');
    expect(existsSync(replacementTempPath(target, '11111111-1111-4111-8111-111111111111'))).toBe(false);
  });

  it('fails a temporary collision after one factory call without retry, reuse, or cleanup', () => {
    const target = join(root, 'state.json');
    const id = '22222222-2222-4222-8222-222222222222';
    const leaked = replacementTempPath(target, id);
    writeFileSync(leaked, 'old-crash-prefix');
    const factory = jest.fn<() => string>(() => id);
    expect(() => replaceFile(target, Buffer.from('new'), factory)).toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(readFileSync(leaked, 'utf8')).toBe('old-crash-prefix');
    expect(existsSync(target)).toBe(false);
  });

  it('leaves a prior orphan untouched while a later independent replacement succeeds', () => {
    const target = join(root, 'state.json');
    const first = replacementTempPath(target, '33333333-3333-4333-8333-333333333333');
    writeFileSync(first, 'abandoned');
    replaceFile(target, Buffer.from('published'), () => '44444444-4444-4444-8444-444444444444');
    expect(readFileSync(target, 'utf8')).toBe('published');
    expect(readFileSync(first, 'utf8')).toBe('abandoned');
  });

  it('uses ordinary Node defaults filtered by the current umask', () => {
    const target = join(root, 'nested', 'state.json');
    mkdirSync(join(root, 'nested'));
    replaceFile(target, Buffer.from('published'), () => '55555555-5555-4555-8555-555555555555');
    const mask = process.umask();
    expect(statSync(target).mode & 0o777).toBe(0o666 & ~mask);
    expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o777 & ~mask);
  });
});
