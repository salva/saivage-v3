import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const roots: string[] = [];
let target = '';
let phase: 'first' | 'append' | null = null;
let publicationFailure: Error;
let faultFired = false;
let observing = false;
let appendDescriptor: number | null = null;
const evidenceDescriptors = new Set<number>();
const afterFault: string[] = [];
const attemptedWrites: string[] = [];

function relevant(path: unknown): boolean { return target !== '' && typeof path === 'string' && (path === dirname(target) || (path.startsWith(dirname(target)) && path.includes('provider-exchange.jsonl'))); }
function record(operation: string, path: unknown): void { if (observing && faultFired && relevant(path)) afterFault.push(operation); }

const openSync = ((...args: Parameters<typeof realFs.openSync>) => {
  record('open', args[0]);
  const descriptor = realFs.openSync(...args);
  if (relevant(args[0])) evidenceDescriptors.add(descriptor);
  if (observing && args[0] === target && phase === 'append' && (Number(args[1]) & realFs.constants.O_APPEND)) appendDescriptor = descriptor;
  return descriptor;
}) as typeof realFs.openSync;
const readFileSync = ((...args: Parameters<typeof realFs.readFileSync>) => { record('read', args[0]); return realFs.readFileSync(...args); }) as typeof realFs.readFileSync;
const lstatSync = ((...args: Parameters<typeof realFs.lstatSync>) => { record('lstat', args[0]); return realFs.lstatSync(...args); }) as typeof realFs.lstatSync;
const renameSync = ((...args: Parameters<typeof realFs.renameSync>) => {
  record('rename', args[1]);
  if (observing && phase === 'first' && args[1] === target) { attemptedWrites.push('rename'); faultFired = true; throw publicationFailure; }
  return realFs.renameSync(...args);
}) as typeof realFs.renameSync;
const fsyncSync = ((...args: Parameters<typeof realFs.fsyncSync>) => {
  if (observing && phase === 'append' && args[0] === appendDescriptor) { attemptedWrites.push('fsync'); faultFired = true; throw publicationFailure; }
  if (observing && faultFired) afterFault.push('fsync');
  return realFs.fsyncSync(...args);
}) as typeof realFs.fsyncSync;
const closeSync = ((...args: Parameters<typeof realFs.closeSync>) => {
  if (observing && faultFired && evidenceDescriptors.has(args[0])) afterFault.push('close');
  evidenceDescriptors.delete(args[0]);
  return realFs.closeSync(...args);
}) as typeof realFs.closeSync;
const readSync = ((...args: Parameters<typeof realFs.readSync>) => {
  if (observing && faultFired && evidenceDescriptors.has(args[0])) afterFault.push('read');
  return Reflect.apply(realFs.readSync, undefined, args);
}) as typeof realFs.readSync;
const writeSync = ((...args: Parameters<typeof realFs.writeSync>) => {
  if (observing && faultFired && evidenceDescriptors.has(args[0])) afterFault.push('write');
  return Reflect.apply(realFs.writeSync, undefined, args);
}) as typeof realFs.writeSync;
const unlinkSync = ((...args: Parameters<typeof realFs.unlinkSync>) => { record('unlink', args[0]); return realFs.unlinkSync(...args); }) as typeof realFs.unlinkSync;
const readdirSync = ((...args: Parameters<typeof realFs.readdirSync>) => { record('readdir', args[0]); return Reflect.apply(realFs.readdirSync, undefined, args); }) as typeof realFs.readdirSync;

jest.unstable_mockModule('node:fs', () => ({ ...realFs, openSync, readFileSync, lstatSync, renameSync, fsyncSync, closeSync, readSync, writeSync, unlinkSync, readdirSync }));

const { InvocationService } = await import('../../src/agents/invocation-service.js');
const { providerExchangeFile } = await import('../../src/persistence/layout.js');
const { PublicationOutcomeUnknownError, throwIfPublicationOutcomeUnknown } = await import('../../src/contracts/publication-outcome.js');

const owner = 'agent:planner:project' as const;
const noOutputs = { assistantOutputIds: [], terminalConversationOutputId: null } as const;
const attempt = (input: string, index: number) => ({
  contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'test', model: 'model',
  source_input_id: input, attempt_index: index, request_params: { endpoint: 'https://example.invalid/v1', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-09-29T00:00:00.000Z',
  completed_at: '2026-09-29T00:00:01.000Z', status: 'ok' as const, terminal_tool_fired: null,
});

afterEach(() => {
  observing = false;
  phase = null;
  target = '';
  evidenceDescriptors.clear();
  while (roots.length) realFs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('provider evidence publication uncertainty', () => {
  it.each(['first', 'append'] as const)('propagates the identical fatal boundary after %s publication without follow-up', (stage) => {
    const root = realFs.mkdtempSync(join(tmpdir(), 'saivage-evidence-uncertainty-'));
    roots.push(root);
    target = providerExchangeFile(root, owner);
    realFs.mkdirSync(dirname(target), { recursive: true });
    const hint = jest.fn();
    const service = new InvocationService({ projectRoot: root, freshness: { llmExchangeChanged: hint }, registry: {} as never, candidateAvailability: {} as never });
    if (stage === 'append') service.projectProviderExchanges(owner, 'primary', 'seed', [attempt('seed', 0)], noOutputs);
    hint.mockClear();
    publicationFailure = new Error(`injected ${stage} syscall failure`);
    phase = stage;
    afterFault.length = 0;
    attemptedWrites.length = 0;
    appendDescriptor = null;
    faultFired = false;
    observing = true;

    let caught: unknown;
    try { service.projectProviderExchanges(owner, 'primary', 'failing', [attempt('failing', 0), attempt('failing', 1)], noOutputs); }
    catch (error) { caught = error; }
    observing = false;

    expect(attemptedWrites).toEqual([stage === 'first' ? 'rename' : 'fsync']);
    expect(caught).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect((caught as Error).cause).toBe(publicationFailure);
    let forwarded: unknown;
    try { throwIfPublicationOutcomeUnknown(caught); } catch (error) { forwarded = error; }
    expect(forwarded).toBe(caught);
    expect(afterFault).toEqual([]);
    expect(hint).not.toHaveBeenCalled();
  });
});
