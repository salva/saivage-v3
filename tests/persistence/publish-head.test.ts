import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, existsSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishHeadFile, type HeadSlotIo } from '../../src/persistence/publish-head.js';
import type { ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'previous-head-')); roots.push(root);
  return { root, current: join(root, 'head.json'), previous: join(root, 'head.prev.json') };
}

describe('owner-local previous head publication', () => {
  it('clears an exact initial slot and retains the former inode across replacements', () => {
    const { current, previous } = fixture();
    writeFileSync(previous, 'obsolete');
    publishHeadFile(current, previous, Buffer.from('first'), 'initial');
    expect(existsSync(previous)).toBe(false);
    const first = statSync(current).ino;
    publishHeadFile(current, previous, Buffer.from('second'), 'replacement');
    expect(statSync(previous).ino).toBe(first);
    expect(statSync(current).ino).not.toBe(first);
    expect(readFileSync(previous, 'utf8')).toBe('first');
    const second = statSync(current).ino;
    publishHeadFile(current, previous, Buffer.from('third'), 'replacement');
    expect(statSync(previous).ino).toBe(second);
    expect(readFileSync(previous, 'utf8')).toBe('second');
  });

  it.each(['initial', 'replacement'] as const)('orders exact slot effects before fresh current publication (%s)', (mode) => {
    const { current, previous } = fixture(); if (mode === 'replacement') writeFileSync(current, 'old');
    const trace: string[] = [];
    const slot: HeadSlotIo = {
      unlink(path) { expect(path).toBe(previous); trace.push('unlink'); unlinkSync(path); },
      link(from, to) { expect([from, to]).toEqual([current, previous]); trace.push('link'); linkSync(from, to); },
    };
    const io: ReplacementFileIo = {
      open: (...args) => { trace.push('open'); return openSync(...args); },
      write: ((...args: Parameters<typeof writeSync>) => { trace.push('write'); return writeSync(...args); }) as typeof writeSync,
      fsync(fd) { trace.push('fsync'); fsyncSync(fd); },
      close(fd) { trace.push('close'); closeSync(fd); },
      rename(from, to) { trace.push('rename'); renameSync(from, to); },
    };
    publishHeadFile(current, previous, Buffer.from('new'), mode, undefined, io, slot);
    expect(trace).toEqual(['unlink', ...(mode === 'replacement' ? ['link'] : []), 'open', 'fsync', 'close', 'open', 'write', 'fsync', 'close', 'rename', 'open', 'fsync', 'close']);
  });

  it.each([['unlink', 'EACCES'], ['unlink', 'EIO'], ['link', 'ENOENT'], ['link', 'EXDEV'], ['link', 'EEXIST']])('fails directly on %s %s without allocating or publishing current', (operation, code) => {
    const { current, previous } = fixture(); writeFileSync(current, 'old');
    const error = Object.assign(new Error(code), { code }); const trace: string[] = [];
    const slot: HeadSlotIo = {
      unlink() { trace.push('unlink'); if (operation === 'unlink') throw error; },
      link() { trace.push('link'); throw error; },
    };
    expect(() => publishHeadFile(current, previous, Buffer.from('new'), 'replacement', () => { trace.push('allocate'); return ''; }, undefined, slot)).toThrow(error);
    expect(trace).toEqual(operation === 'unlink' ? ['unlink'] : ['unlink', 'link']);
    expect(readFileSync(current, 'utf8')).toBe('old');
  });

  it.each(['open', 'fsync', 'close'] as const)('treats previous-slot directory %s failure as unknown and stops without cleanup', (phase) => {
    const { current, previous } = fixture(); writeFileSync(current, 'old');
    const error = new Error(phase); const trace: string[] = [];
    const hit = (name: string) => { trace.push(name); if (name === phase) throw error; };
    const io: ReplacementFileIo = {
      open() { hit('open'); return 123; }, fsync() { hit('fsync'); }, close() { hit('close'); },
      write: (() => { throw new Error('not reached'); }) as typeof writeSync,
      rename() { throw new Error('not reached'); },
    };
    let caught: unknown;
    try { publishHeadFile(current, previous, Buffer.from('new'), 'replacement', () => { throw new Error('not reached'); }, io); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect((caught as Error).cause).toBe(error);
    expect(trace).toEqual(['open', 'fsync', 'close'].slice(0, ['open', 'fsync', 'close'].indexOf(phase) + 1));
    // A possible interrupted prefix is prev=current, not a promised earlier selection.
    expect(statSync(previous).ino).toBe(statSync(current).ino);
  });

  it('does not reinterpret a missing established current as initial or preserve a usable previous slot', () => {
    const { current, previous } = fixture(); writeFileSync(previous, 'old opportunity');
    expect(() => publishHeadFile(current, previous, Buffer.from('new'), 'replacement')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(current)).toBe(false);
  });
});
