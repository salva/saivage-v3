import { afterEach, describe, expect, it } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isProjectDirectoryExcluded,
  loadProjectSearchIgnore,
  parseProjectSearchIgnore,
} from '../../src/workspace/project-search-ignore.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function fail(message: string): Error { return new Error(message); }

describe('project search ignore policy', () => {
  it('parses comments, whitespace, CRLF, Unicode, duplicates, and overlapping literal roots', () => {
    const policy = parseProjectSearchIgnore(Buffer.from('  # note\r\n artifacts/generated \r\nartifacts/generated\nartifacts/generated/old\n输出/旧结果\n'), fail);
    expect([...policy]).toEqual(['artifacts/generated', 'artifacts/generated/old', '输出/旧结果']);
    expect(isProjectDirectoryExcluded(policy, 'artifacts/generated')).toBe(true);
    expect(isProjectDirectoryExcluded(policy, 'artifacts/generated/old/deep')).toBe(true);
    expect(isProjectDirectoryExcluded(policy, 'artifacts/generated-fixtures')).toBe(false);
    expect(isProjectDirectoryExcluded(policy, 'nested/artifacts/generated')).toBe(false);
  });

  it.each([
    '', '# only\n',
  ])('accepts an absent-effective policy %#', (text) => {
    expect(parseProjectSearchIgnore(Buffer.from(text), fail).size).toBe(0);
  });

  it.each([
    '/', '/absolute', 'trailing/', './relative', 'a/../b', 'a//b', 'a\\b', 'C:/drive',
    'project:///url', '!exception', 'wild*card', 'question?', 'class[ab]', 'brace{x}', 'a\0b',
  ])('rejects invalid entry %j without disclosing it', (entry) => {
    expect(() => parseProjectSearchIgnore(Buffer.from(`ok/path\n${entry}\n`), fail)).toThrow('Invalid .saivage-search-ignore line 2: entry must be a literal project-relative directory path.');
    try { parseProjectSearchIgnore(Buffer.from(`ok/path\n${entry}\n`), fail); }
    catch (error) { expect((error as Error).message).not.toContain(entry); }
  });

  it.each([
    ['invalid continuation', Buffer.from([0x61, 0x2f, 0xc3, 0x28])],
    ['truncated multibyte', Buffer.from([0x61, 0x2f, 0xe2, 0x82])],
  ])('fatal-decodes malformed UTF-8: %s', (_name, bytes) => {
    expect(() => parseProjectSearchIgnore(bytes, fail)).toThrow('Invalid .saivage-search-ignore: file is not valid UTF-8.');
  });

  it.each([
    ['before an entry', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('generated')])],
    ['BOM only', Buffer.from([0xef, 0xbb, 0xbf])],
    ['repeated BOM', Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf])],
  ])('rejects a leading UTF-8 BOM: %s', (_name, bytes) => {
    expect(() => parseProjectSearchIgnore(bytes, fail)).toThrow('Invalid .saivage-search-ignore line 1: UTF-8 BOM is not allowed.');
  });

  it('direct-reads only the exact optional file and treats only absence as empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-search-ignore-'));
    roots.push(root);
    expect(loadProjectSearchIgnore(root, fail).size).toBe(0);
    writeFileSync(join(root, '.saivage-search-ignore'), 'future/output\n');
    expect([...loadProjectSearchIgnore(root, fail)]).toEqual(['future/output']);
    rmSync(join(root, '.saivage-search-ignore'));
    mkdirSync(join(root, '.saivage-search-ignore'));
    expect(() => loadProjectSearchIgnore(root, fail)).toThrow('Cannot read .saivage-search-ignore.');
  });
});
