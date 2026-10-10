import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import {
  ProcessRunner,
  ProcessEvidenceUnavailableError,
} from '../../src/runtime/process-runner.js';
import {
  ProcessToolResultSchema,
  ProcessViewSchema,
  PublicationOutcomeUnknownError,
} from '../../src/contracts/index.js';
import { buildProcessView } from '../../src/application/read-models/process-view.js';
import { buildProcessOperatorContractHandlers } from '../../src/server/routes/operator-process-handlers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { SyntheticProcessPlatform } from '../helpers/synthetic-process-platform.js';

const roots: string[] = [];
const platforms: SyntheticProcessPlatform[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  platforms.splice(0).forEach((platform) => platform.destroy());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  io?: ConstructorParameters<typeof ProcessRunner>[3],
  fatal = testApplicationFatalPort,
) {
  const root = mkdtempSync(join(tmpdir(), 'unavailable-'));
  roots.push(root);
  const platform = new SyntheticProcessPlatform();
  platforms.push(platform);
  const registry = new ManagedProcessGroupRegistry(platform);
  const scope = registry.createDirectScope(registry.rootScope, 'owner', 'runtime_card');
  const runner = new ProcessRunner(root, registry, fatal, io);
  const record = runner.spawn({
    command: 'synthetic',
    directScope: scope,
    category: 'runtime_card',
    ownerId: 'owner',
    ownerKind: 'agent',
  });
  const child = platform.children[0]!;
  const lose = async () => {
    platform.states.set(child.pid!, 'EPERM');
    return runner.closeAndTerminateDirectScope({
      directScope: scope,
      category: 'runtime_card',
      reason: 'close',
      graceMs: 0,
    });
  };
  return { root, platform, registry, scope, runner, record, child, lose };
}

describe('unavailable process evidence through real registry/runner', () => {
  it('redacts the first group diagnostic without changing internal retained authority evidence', async () => {
    const f = fixture();
    const diagnostic = 'probe denied Authorization: Bearer synthetic-group-secret';
    f.platform.probe = () => {
      throw Object.assign(new Error(diagnostic), { code: 'EPERM' });
    };
    await f.runner.terminateScopeTree({
      rootScope: f.registry.rootScope,
      categories: ['runtime_card'],
      reason: 'root',
      graceMs: 0,
    });
    const internal = f.runner.get(f.record.id)!;
    expect(internal.evidence.group_diagnostic).toContain('synthetic-group-secret');
    const view = buildProcessView(f.root, internal);
    expect(view.evidence.group_diagnostic).toContain('[REDACTED]');
    expect(JSON.stringify(view)).not.toContain('synthetic-group-secret');
    expect(internal.evidence.group_diagnostic).toContain('synthetic-group-secret');
  });
  it('rejects entered waits promptly, exposes independent facts through actual API handler, and never retires/reauthorizes', async () => {
    const f = fixture();
    const unbounded = f.runner.waitForSettlement(f.record.id).catch((error) => error);
    // The bounded wait owns only its local timer, not registry or drain cleanup.
    const allocate = jest.spyOn(globalThis, 'setTimeout');
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    const timed = f.runner.wait(f.record.id, 20).catch((error) => error);
    expect(allocate).toHaveBeenCalledTimes(1);
    const handle = allocate.mock.results[0]!.value as ReturnType<typeof setTimeout>;
    const report = await f.lose();
    const lossOperations = [...f.platform.operations];
    expect(report.failed).toHaveLength(1);
    expect(await unbounded).toBeInstanceOf(ProcessEvidenceUnavailableError);
    expect(await timed).toBeInstanceOf(ProcessEvidenceUnavailableError);
    expect(clear).toHaveBeenCalledWith(handle);
    expect(f.runner.get(f.record.id)).toMatchObject({ status: 'unavailable', evidence: { stdout: 'open', stderr: 'open' } });
    expect(f.child.stdout.destroyed).toBe(false);
    expect(f.child.stderr.destroyed).toBe(false);
    allocate.mockClear();
    await expect(f.runner.wait(f.record.id, 20)).rejects.toBeInstanceOf(
      ProcessEvidenceUnavailableError,
    );
    await expect(f.runner.wait(f.record.id, 0)).rejects.toBeInstanceOf(
      ProcessEvidenceUnavailableError,
    );
    expect(allocate).not.toHaveBeenCalled();
    expect(f.platform.operations).toEqual(lossOperations);
    allocate.mockRestore();
    clear.mockRestore();
    const api = Fastify();
    const handlers = buildProcessOperatorContractHandlers({
      projectRoot: f.root,
      processRunner: f.runner,
    });
    api.get('/processes', async () => (await handlers['processes.list']({} as never)).body);
    try {
      const read = async () =>
        ProcessViewSchema.parse((await api.inject('/processes')).json().processes[0]);
      const before = await read();
      expect(before).toMatchObject({
        status: 'unavailable',
        ended_at: null,
        exit_code: null,
        evidence: { group: 'unverifiable', leader_exit: null, stdout: 'open', stderr: 'open' },
      });
      expect(before.logs.stdout).toContain(`/${f.record.id}/stdout.log`);
      expect(f.child.stdout.destroyed).toBe(false);
      f.child.emit('exit', 1, null);
      f.child.stdout.end();
      f.child.stderr.emit('close');
      await turn();
      const after = await read();
      expect(after).toMatchObject({
        status: 'unavailable',
        ended_at: null,
        exit_code: null,
        evidence: {
          group: 'unverifiable',
          leader_exit: { exit_code: 1, signal: null },
          stdout: 'eof',
          stderr: 'closed',
        },
      });
      expect(before.evidence.leader_exit).toBeNull();
      expect(before.evidence.stdout).toBe('open');
      const operations = [...f.platform.operations];
      f.platform.states.set(f.child.pid!, 'ESRCH');
      await expect(
        f.runner.kill(f.record.id, { directScope: f.scope, category: 'runtime_card' }),
      ).rejects.toThrow('unverifiable');
      await expect(
        f.runner.closeAndTerminateDirectScope({
          directScope: f.scope,
          category: 'runtime_card',
          reason: 'again',
        }),
      ).rejects.toThrow('closed');
      const repeated = await f.runner.terminateScopeTree({
        rootScope: f.registry.rootScope,
        categories: ['runtime_card'],
        reason: 'root',
      });
      expect(repeated.failed).toEqual(report.failed);
      f.runner.retireSettled(f.record.id, f.scope);
      expect(f.runner.list()).toHaveLength(1);
      expect(f.platform.operations).toEqual(operations);
      const sibling = f.registry.createDirectScope(f.registry.rootScope, 'owner', 'runtime_card');
      expect(() => f.runner.retireSettled(f.record.id, sibling)).toThrow('not bound');
    } finally {
      await api.close();
    }
  });

  it.each(['before', 'after'] as const)(
    'preserves %s capture error identity separately from actual open, EOF and close facts',
    async (ordering) => {
      const f = fixture();
      const capture = new Error('Authorization: Bearer synthetic-capture-secret');
      if (ordering === 'before') f.child.stdout.emit('error', capture);
      const held = f.runner.waitForSettlement(f.record.id).catch((error) => error);
      await f.lose();
      expect(await held).toEqual(
        ordering === 'before' ? capture : expect.any(ProcessEvidenceUnavailableError),
      );
      if (ordering === 'after') f.child.stdout.emit('error', capture);
      f.child.stderr.emit('error', capture);
      const prior = f.runner.get(f.record.id)!;
      expect(prior.evidence).toMatchObject({
        stdout: 'open',
        stderr: 'open',
        stdout_error: capture.message,
        stderr_error: capture.message,
      });
      await expect(f.runner.wait(f.record.id, 0)).rejects.toBe(capture);
      f.child.stdout.end();
      f.child.stderr.emit('close');
      await turn();
      f.child.stdout.emit('close');
      const view = buildProcessView(f.root, f.runner.get(f.record.id)!);
      expect(view.evidence).toMatchObject({
        stdout: 'eof',
        stderr: 'closed',
        stdout_error: expect.stringContaining('[REDACTED]'),
        stderr_error: expect.stringContaining('[REDACTED]'),
      });
      expect(JSON.stringify(view)).not.toContain('synthetic-capture-secret');
      expect(prior.evidence.stdout).toBe('open');
      expect(prior.evidence.stderr).toBe('open');
      await expect(f.runner.waitForSettlement(f.record.id)).rejects.toBe(capture);
    },
  );

  it('append-open failure records real destruction/close, not fabricated EOF', async () => {
    const capture = Object.assign(new Error('append open failed'), { code: 'EMFILE' });
    const f = fixture({
      output: {
        open: () => {
          throw capture;
        },
      } as never,
    });
    f.child.stdout.write('output');
    await turn();
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.runner.get(f.record.id)?.evidence).toMatchObject({
      stdout: 'closed',
      stdout_error: capture.message,
    });
    await f.lose();
    await expect(f.runner.waitForSettlement(f.record.id)).rejects.toBe(capture);
  });

  it('leader error is not an invented exit; actual later successful leader exit and both EOFs never certify cleanup', async () => {
    const f = fixture();
    f.child.emit('error', new Error('Authorization: Bearer synthetic-leader-secret'));
    expect(f.runner.get(f.record.id)?.evidence.leader_exit).toBeNull();
    f.platform.states.set(f.child.pid!, 'EPERM');
    f.child.emit('exit', 0, null);
    f.child.stdout.end();
    f.child.stderr.end();
    await turn();
    const view = buildProcessView(f.root, f.runner.get(f.record.id)!);
    expect(view).toMatchObject({
      status: 'unavailable',
      ended_at: null,
      exit_code: null,
      evidence: {
        leader_exit: { exit_code: 0 },
        leader_error: { diagnostic: expect.stringContaining('[REDACTED]') },
        stdout: 'eof',
        stderr: 'eof',
      },
    });
    expect(JSON.stringify(view)).not.toContain('synthetic-leader-secret');
    await expect(f.runner.waitForSettlement(f.record.id)).rejects.toBeInstanceOf(
      ProcessEvidenceUnavailableError,
    );
    expect(ProcessToolResultSchema.innerType().shape.status.safeParse('unavailable').success).toBe(
      false,
    );
  });

  it('root containment retires successful siblings but never joins unavailable open drains', async () => {
    const f = fixture();
    const siblingScope = f.registry.createDirectScope(
      f.registry.rootScope,
      'sibling',
      'runtime_card',
    );
    const sibling = f.runner.spawn({
      command: 'sibling',
      directScope: siblingScope,
      category: 'runtime_card',
      ownerId: 'sibling',
      ownerKind: 'agent',
    });
    await f.lose();
    const report = await f.runner.terminateScopeTree({
      rootScope: f.registry.rootScope,
      categories: ['runtime_card'],
      reason: 'root',
      graceMs: 0,
    });
    expect(report.stopped).toEqual([sibling.id]);
    expect(report.failed).toHaveLength(1);
    expect(f.runner.get(sibling.id)).toBeNull();
    expect(f.runner.get(f.record.id)?.status).toBe('unavailable');
    expect(f.child.stdout.destroyed).toBe(false);
  });

  it('publication uncertainty reaches fatal before evidence notification or destruction', () => {
    const original = new Error('write uncertain');
    const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => {
      throw error;
    });
    const f = fixture(
      {
        output: {
          open: () => 1,
          stat: () => ({ isFile: () => true }),
          write: () => {
            throw original;
          },
        } as never,
      },
      { publicationOutcomeUnknown: fatal },
    );
    const destroy = jest.spyOn(f.child.stdout, 'destroy');
    expect(() => f.child.stdout.write('uncertain')).toThrow(PublicationOutcomeUnknownError);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    // Synthetic spy inspection only; never call runner cleanup after a fatal publication.
    expect(f.record.evidence.stdout_error).toBeNull();
    expect(f.platform.operations).toEqual([]);
  });
});
