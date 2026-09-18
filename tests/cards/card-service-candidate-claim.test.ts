import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const candidateMkdirPaths: string[] = [];
const candidateInspectionPaths: string[] = [];
const inspectionsAfterFailure: string[] = [];
let childrenPath: string | null = null;
let injectedCandidatePath: string | null = null;
let injectedFailure: NodeJS.ErrnoException | null = null;
let failureThrown = false;
let readdirCalls = 0;
let strandedCandidateUnderInspection: string | null = null;
const strandedCandidateInspections: string[] = [];

function traceInspection(name: string, path: unknown): void {
  const inspectedPath = String(path);
  if (childrenPath !== null && dirname(inspectedPath) === childrenPath) candidateInspectionPaths.push(inspectedPath);
  if (strandedCandidateUnderInspection !== null) {
    const fromCandidate = relative(strandedCandidateUnderInspection, inspectedPath);
    if (fromCandidate === '' || (!fromCandidate.startsWith('..') && !isAbsolute(fromCandidate))) strandedCandidateInspections.push(`${name}:${inspectedPath}`);
  }
  if (failureThrown) inspectionsAfterFailure.push(name);
}

const mockedMkdirSync = ((...args: unknown[]) => {
  const path = String(args[0]);
  if (childrenPath !== null && dirname(path) === childrenPath) candidateMkdirPaths.push(path);
  if (path === injectedCandidatePath) {
    failureThrown = true;
    throw injectedFailure;
  }
  return Reflect.apply(realFs.mkdirSync, undefined, args);
}) as typeof realFs.mkdirSync;
const mockedReadFileSync = ((...args: unknown[]) => { traceInspection('readFileSync', args[0]); return Reflect.apply(realFs.readFileSync, undefined, args); }) as typeof realFs.readFileSync;
const mockedLstatSync = ((...args: unknown[]) => { traceInspection('lstatSync', args[0]); return Reflect.apply(realFs.lstatSync, undefined, args); }) as typeof realFs.lstatSync;
const mockedOpenSync = ((...args: unknown[]) => { traceInspection('openSync', args[0]); return Reflect.apply(realFs.openSync, undefined, args); }) as typeof realFs.openSync;
const mockedReaddirSync = ((...args: unknown[]) => { traceInspection('readdirSync', args[0]); readdirCalls += 1; return Reflect.apply(realFs.readdirSync, undefined, args); }) as typeof realFs.readdirSync;
const mockedStatSync = ((...args: unknown[]) => { traceInspection('statSync', args[0]); return Reflect.apply(realFs.statSync, undefined, args); }) as typeof realFs.statSync;
const mockedAccessSync = ((...args: unknown[]) => { traceInspection('accessSync', args[0]); return Reflect.apply(realFs.accessSync, undefined, args); }) as typeof realFs.accessSync;
const mockedExistsSync = ((...args: unknown[]) => { traceInspection('existsSync', args[0]); return Reflect.apply(realFs.existsSync, undefined, args); }) as typeof realFs.existsSync;
const mockedReadlinkSync = ((...args: unknown[]) => { traceInspection('readlinkSync', args[0]); return Reflect.apply(realFs.readlinkSync, undefined, args); }) as typeof realFs.readlinkSync;
const mockedRealpathSync = ((...args: unknown[]) => { traceInspection('realpathSync', args[0]); return Reflect.apply(realFs.realpathSync, undefined, args); }) as typeof realFs.realpathSync;

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  mkdirSync: mockedMkdirSync,
  readFileSync: mockedReadFileSync,
  lstatSync: mockedLstatSync,
  openSync: mockedOpenSync,
  readdirSync: mockedReaddirSync,
  statSync: mockedStatSync,
  accessSync: mockedAccessSync,
  existsSync: mockedExistsSync,
  readlinkSync: mockedReadlinkSync,
  realpathSync: mockedRealpathSync,
}));

const { CardService } = await import('../helpers/canonical-project.js');
const { cardStreamFile } = await import('../../src/persistence/layout.js');
const { initProjectTree } = await import('../helpers/canonical-project.js');

const roots: string[] = [];
const input = { type: 'code' as const, parent: 'project', title: 'Claim', bootstrap_content: 'Claim directly.', priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [] };

beforeEach(() => {
  candidateMkdirPaths.length = 0;
  candidateInspectionPaths.length = 0;
  inspectionsAfterFailure.length = 0;
  childrenPath = null;
  injectedCandidatePath = null;
  injectedFailure = null;
  failureThrown = false;
  readdirCalls = 0;
  strandedCandidateUnderInspection = null;
  strandedCandidateInspections.length = 0;
});
afterEach(() => { while (roots.length > 0) realFs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct child namespace claims', () => {
  it('progresses through z to aa without enumerating or inspecting occupied candidates', () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'saivage-candidate-claim-'));
    roots.push(root);
    initProjectTree(root);
    childrenPath = join(root, '.saivage', 'cards', 'project', 'children');
    realFs.mkdirSync(childrenPath);
    for (let code = 'a'.charCodeAt(0); code <= 'z'.charCodeAt(0); code += 1) realFs.writeFileSync(join(childrenPath, String.fromCharCode(code)), 'opaque');

    expect(new CardService(root).create(input).id).toBe('card-aa');
    expect(candidateMkdirPaths.map((path) => basename(path))).toEqual([...'abcdefghijklmnopqrstuvwxyz', 'aa']);
    expect(readdirCalls).toBe(0);
    expect(candidateInspectionPaths.filter((path) => basename(path) !== 'aa')).toEqual([]);
    for (const segment of 'abcdefghijklmnopqrstuvwxyz') expect(realFs.readFileSync(join(childrenPath, segment), 'utf8')).toBe('opaque');
  });

  it('propagates the exact non-EEXIST error with no later work or inspection', () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'saivage-candidate-claim-'));
    roots.push(root);
    initProjectTree(root);
    childrenPath = join(root, '.saivage', 'cards', 'project', 'children');
    injectedCandidatePath = join(childrenPath, 'a');
    injectedFailure = Object.assign(new Error('candidate denied'), { code: 'EACCES' });
    const parentBytes = realFs.readFileSync(cardStreamFile(root, 'project'));
    const appendOperations: string[] = [];
    const io = {
      open: ((...args: unknown[]) => { appendOperations.push('open'); return Reflect.apply(realFs.openSync, undefined, args); }) as typeof realFs.openSync,
      stat: (descriptor: number) => { appendOperations.push('stat'); return realFs.fstatSync(descriptor); },
      write: ((...args: unknown[]) => { appendOperations.push('write'); return Reflect.apply(realFs.writeSync, undefined, args); }) as typeof realFs.writeSync,
      fsync: ((...args: unknown[]) => { appendOperations.push('fsync'); return Reflect.apply(realFs.fsyncSync, undefined, args); }) as typeof realFs.fsyncSync,
      close: ((...args: unknown[]) => { appendOperations.push('close'); return Reflect.apply(realFs.closeSync, undefined, args); }) as typeof realFs.closeSync,
    };
    const cardChanged = jest.fn();
    const runtimeChanged = jest.fn();

    let caught: unknown;
    try { new CardService(root, { cardProjectionChanged: cardChanged, runtimeChanged,agentMembershipChanged:jest.fn() }, io).create(input); } catch (error) { caught = error; }

    expect(caught).toBe(injectedFailure);
    expect(candidateMkdirPaths).toEqual([injectedCandidatePath]);
    expect(realFs.existsSync(join(childrenPath, 'b'))).toBe(false);
    expect(realFs.existsSync(injectedCandidatePath)).toBe(false);
    expect(realFs.readFileSync(cardStreamFile(root, 'project'))).toEqual(parentBytes);
    expect(appendOperations).toEqual([]);
    expect(cardChanged).not.toHaveBeenCalled();
    expect(runtimeChanged).not.toHaveBeenCalled();
    expect(inspectionsAfterFailure).toEqual([]);
  });

  it('consumes a safely published but unlinked candidate without inspecting it before claiming the next candidate', () => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'saivage-candidate-claim-'));
    roots.push(root);
    initProjectTree(root);
    childrenPath = join(root, '.saivage', 'cards', 'project', 'children');
    const strandedCandidate = join(childrenPath, 'a');
    const parentPath = cardStreamFile(root, 'project');
    const linkFailure = Object.assign(new Error('parent link open denied'), { code: 'EACCES' });
    const linkOperations: string[] = [];
    const failingLinkIo = {
      open: ((path: string) => { linkOperations.push(`open:${path}`); if (path === parentPath) throw linkFailure; throw new Error(`Unexpected append target '${path}'.`); }) as typeof realFs.openSync,
      stat: ((descriptor: number) => { linkOperations.push('stat'); return realFs.fstatSync(descriptor); }) as typeof realFs.fstatSync,
      write: ((...args: Parameters<typeof realFs.writeSync>) => { linkOperations.push('write'); return Reflect.apply(realFs.writeSync, undefined, args); }) as typeof realFs.writeSync,
      fsync: ((...args: Parameters<typeof realFs.fsyncSync>) => { linkOperations.push('fsync'); return Reflect.apply(realFs.fsyncSync, undefined, args); }) as typeof realFs.fsyncSync,
      close: ((...args: Parameters<typeof realFs.closeSync>) => { linkOperations.push('close'); return Reflect.apply(realFs.closeSync, undefined, args); }) as typeof realFs.closeSync,
    };
    const cardChanged = jest.fn();
    const runtimeChanged = jest.fn();
    const membershipChanged = jest.fn();

    let caught: unknown;
    try {
      new CardService(root, { cardProjectionChanged: cardChanged, runtimeChanged, agentMembershipChanged: membershipChanged }, failingLinkIo).create(input);
    } catch (error) { caught = error; }

    expect(caught).toBe(linkFailure);
    expect(linkOperations).toEqual([`open:${parentPath}`]);
    expect(cardChanged).not.toHaveBeenCalled();
    expect(runtimeChanged).not.toHaveBeenCalled();
    expect(membershipChanged).not.toHaveBeenCalled();

    strandedCandidateUnderInspection = strandedCandidate;
    const service = new CardService(root);
    const linked = service.create(input);

    expect(linked.id).toBe('card-b');
    expect(candidateMkdirPaths.map((path) => basename(path))).toEqual(['a', 'a', 'b']);
    expect(strandedCandidateInspections).toEqual([]);
    expect(service.read('project')).toMatchObject({ child_membership: ['card-b'], active_child_order: ['card-b'] });
    expect(service.read(linked.id)?.id).toBe('card-b');
  });
});
