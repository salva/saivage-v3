import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { publicationPhases, publicationWitness, type PublicationFault } from '../helpers/segment-publication-io.js';
import type { AgentMessage } from '../../src/schemas/index.js';

// Keep ordinary owner APIs unchanged; observe their actual built-in syscall chain.
let observing = false;
let failAt: string | undefined;
let failure = new Error('injected');
const trace: string[] = [];
const descriptors = new Map<number, string>();
function step(label: string) {
  if (!observing) return;
  trace.push(label);
  if (label === failAt) throw failure;
}
jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  lstatSync: (path: string) => { step(`lstat:${basename(path)}`); return realFs.lstatSync(path); },
  openSync: (path: string, flags: number) => {
    step(`open:${basename(path)}`);
    const fd = realFs.openSync(path, flags); descriptors.set(fd, basename(path)); return fd;
  },
  writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => {
    step(`write:${descriptors.get(fd)}`); return realFs.writeSync(fd, bytes, offset, length);
  },
  fsyncSync: (fd: number) => { step(`fsync:${descriptors.get(fd)}`); realFs.fsyncSync(fd); },
  closeSync: (fd: number) => { step(`close:${descriptors.get(fd)}`); realFs.closeSync(fd); },
  renameSync: (from: string, to: string) => { step(`rename:${basename(to)}`); realFs.renameSync(from, to); },
}));
const { publishFreshFile } = await import('../../src/persistence/replace-file.js');
const { replacementTempPath } = await import('../../src/persistence/replace-file.js');
const { appendConversationBatch, readCurrentConversationSegment, readHistoricalConversationSegment } = await import('../../src/persistence/conversation-file.js');
const { initProjectTree } = await import('../helpers/canonical-project.js');
const roots: string[] = [];
function fixture() { const root = realFs.mkdtempSync(join(tmpdir(), 'segment-publication-')); roots.push(root); return root; }
afterEach(() => { observing = false; failAt = undefined; trace.length = 0; descriptors.clear(); while (roots.length) realFs.rmSync(roots.pop()!, { recursive: true, force: true }); });
const id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('{"version":6,"type":"conversation-segment","rows":[{"id":"row"}]}\n');

describe('actual first-envelope segment publication', () => {
  it('propagates non-ENOENT target admission unchanged before asking for a temporary', () => {
    const target = join(fixture(), '1-selected.jsonl');
    failure = Object.assign(new Error('target denied'), { code: 'EACCES' });
    failAt = `lstat:${basename(target)}`; observing = true;
    const factory = jest.fn(() => id); const witness = publicationWitness(); let thrown: unknown;
    try { publishFreshFile(target, bytes, factory, witness.io); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure); expect(factory).not.toHaveBeenCalled(); expect(witness.trace).toEqual([]);
    expect(trace).toEqual([failAt]);
  });

  it('propagates temporary factory failure unchanged after admission without opening anything', () => {
    const target = join(fixture(), '1-selected.jsonl'); const witness = publicationWitness();
    const failed = new Error('temporary factory failed'); const factory = jest.fn(() => { throw failed; }); observing = true;
    let thrown: unknown;
    try { publishFreshFile(target, bytes, factory, witness.io); } catch (error) { thrown = error; }
    expect(thrown).toBe(failed); expect(factory).toHaveBeenCalledTimes(1); expect(witness.trace).toEqual([]);
    expect(trace).toEqual([`lstat:${basename(target)}`]);
  });

  it.each(['file', 'directory', 'dangling-symlink'])('refuses a present exact %s with only target admission', (kind) => {
    const target = join(fixture(), '1-selected.jsonl');
    if (kind === 'file') realFs.writeFileSync(target, 'unchanged');
    else if (kind === 'directory') realFs.mkdirSync(target);
    else realFs.symlinkSync('missing', target);
    const before = realFs.lstatSync(target);
    const factory = jest.fn(() => id); const witness = publicationWitness(); observing = true;
    expect(() => publishFreshFile(target, bytes, factory, witness.io)).toThrow(/already published/);
    expect(trace).toEqual([`lstat:${basename(target)}`]); expect(witness.trace).toEqual([]); expect(factory).not.toHaveBeenCalled();
    expect(realFs.lstatSync(target).ino).toBe(before.ino);
    if (kind === 'file') expect(realFs.readFileSync(target, 'utf8')).toBe('unchanged');
    if (kind === 'dangling-symlink') expect(realFs.readlinkSync(target)).toBe('missing');
  });

  it('fails one exclusive temporary collision without rename, alternate allocation, or cleanup', () => {
    const target = join(fixture(), '1-selected.jsonl'); const temp = replacementTempPath(target, id);
    realFs.writeFileSync(temp, 'collision'); const factory = jest.fn(() => id); observing = true;
    expect(() => publishFreshFile(target, bytes, factory)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(factory).toHaveBeenCalledTimes(1); expect(trace).toEqual([`lstat:${basename(target)}`, `open:${basename(temp)}`]);
    expect(realFs.readFileSync(temp, 'utf8')).toBe('collision');
  });

  it('delegates exact bytes through one exclusive same-directory temporary and only unsent suffixes', () => {
    const target = join(fixture(), '1-selected.jsonl'); const factory = jest.fn(() => id); const witness = publicationWitness(); observing = true;
    publishFreshFile(target, bytes, factory, witness.io);
    expect(trace).toEqual([`lstat:${basename(target)}`]); expect(factory).toHaveBeenCalledTimes(1);
    expect(witness.trace).toEqual(['temp-open', 'write', 'write', 'file-fsync', 'file-close', 'rename', 'parent-open', 'parent-fsync', 'parent-close']);
    expect(witness.opens).toEqual([[replacementTempPath(target, id), realFs.constants.O_CREAT | realFs.constants.O_EXCL | realFs.constants.O_WRONLY], [dirname(target), realFs.constants.O_RDONLY]]);
    expect(witness.writes).toEqual([{ offset: 0, length: bytes.length, bytes }, { offset: 2, length: bytes.length - 2, bytes }]);
    expect(witness.renames).toEqual([[replacementTempPath(target, id), target]]);
  });

  it.each([...publicationPhases, 'zero-write', 'short-write-error', 'rename-effect-throw'] satisfies PublicationFault[])('stops the actual publisher at %s with phase-correct identity', (phase) => {
    const target = join(fixture(), '1-selected.jsonl'); const witness = publicationWitness(phase); const factory = jest.fn(() => id); observing = true;
    let thrown: unknown;
    try { publishFreshFile(target, bytes, factory, witness.io); } catch (error) { thrown = error; }
    const fatal = ['rename', 'rename-effect-throw', 'parent-open', 'parent-fsync', 'parent-close'].includes(phase);
    if (fatal) { expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError); expect((thrown as Error).cause).toBe(witness.failure); }
    else if (phase === 'zero-write') expect((thrown as Error).message).toContain('Write made no progress');
    else expect(thrown).toBe(witness.failure);
    const endpoint = phase === 'zero-write' || phase === 'short-write-error' ? 'write' : phase === 'rename-effect-throw' ? 'rename' : phase;
    const success = ['temp-open', 'write', 'write', 'file-fsync', 'file-close', 'rename', 'parent-open', 'parent-fsync', 'parent-close'];
    const end = phase === 'short-write-error' ? 2 : success.indexOf(endpoint);
    expect(witness.trace).toEqual(success.slice(0, end + 1));
    expect(trace).toEqual([`lstat:${basename(target)}`]); expect(factory).toHaveBeenCalledTimes(1);
    expect(witness.renameEffect()).toBe(phase === 'rename-effect-throw' || phase.startsWith('parent-'));
  });

  it.each(['success', 'segment-rename', 'index-rename'])('ordinary ingress orders segment sync, separate index publication, then hints: %s', (outcome) => {
    const root = fixture(); initProjectTree(root); const temporaries: string[] = []; let segmentName = '';
    const factory = () => {
      const next = `00000000-0000-4000-8000-${String(temporaries.length + 1).padStart(12, '0')}`;
      temporaries.push(next); step(`factory:${temporaries.length}`); return next;
    };
    // Discover the selected identity only from the actual owner publication trace.
    failAt = outcome === 'index-rename' ? 'rename:index.json' : undefined;
    failure = new Error(outcome); observing = true;
    const changes = { conversationChanged() { step('conversation-hint'); }, agentMembershipChanged() { step('membership-hint'); } };
    // A factory runs after exact target admission and before any replacement open.
    const temporary = () => {
      segmentName = trace.find((event) => event.startsWith('lstat:'))!.slice(6);
      if (outcome === 'segment-rename') failAt = `rename:${segmentName}`;
      return factory();
    };
    const message = { id: 'first', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'first', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' } as AgentMessage;
    let thrown: unknown;
    try { appendConversationBatch({ projectRoot: root, changes }, [message], { publicationTemporaryId: temporary }); } catch (error) { thrown = error; }
    const tempSegment = `.${segmentName}.${temporaries[0]}.saivage-tmp`;
    const segmentTrace = [`lstat:${segmentName}`, 'factory:1', `open:${tempSegment}`, `write:${tempSegment}`, `fsync:${tempSegment}`, `close:${tempSegment}`, `rename:${segmentName}`, 'open:versions', 'fsync:versions', 'close:versions'];
    if (outcome === 'segment-rename') expect(trace).toEqual(segmentTrace.slice(0, 7));
    else {
      const tempIndex = `.index.json.${temporaries[1]}.saivage-tmp`;
      const indexTrace = ['open:planner', 'fsync:planner', 'close:planner', 'factory:2', `open:${tempIndex}`, `write:${tempIndex}`, `fsync:${tempIndex}`, `close:${tempIndex}`, 'rename:index.json'];
      expect(trace).toEqual([...segmentTrace, ...indexTrace, ...(outcome === 'success' ? ['open:planner', 'fsync:planner', 'close:planner', 'conversation-hint', 'membership-hint'] : [])]);
    }
    expect(temporaries).toHaveLength(outcome === 'segment-rename' ? 1 : 2);
    if (outcome !== 'success') { expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError); expect((thrown as Error).cause).toBe(failure); }
    else {
      observing = false;
      const segment = readCurrentConversationSegment(root, message.session_id)!;
      expect(segment.entry.filename).toBe(segmentName); expect(segment.rows).toEqual([message]);
      expect(readHistoricalConversationSegment(root, message.session_id, 1).rows).toEqual(segment.rows);
      appendConversationBatch({ projectRoot: root }, [{ ...message, id: 'second' }]);
      expect(readCurrentConversationSegment(root, message.session_id)!.rows.map(row => row.id)).toEqual(['first', 'second']);
    }
  });
});
