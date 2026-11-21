import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkGcOperation, workGcFailureResponse } from '../../src/application/work-gc-operation.js';
import { WorkGcMaintenanceError, WorkGcResponseSchema, WorkGcBusyError, PublicationOutcomeUnknownError, type WorkGcProgress } from '../../src/contracts/index.js';
import { WorkGcInterruptedError, WorkGcReferenceScopeError } from '../../src/workspace/index.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import type { ResolvedConfigAuthority } from '../../src/config/index.js';
import type { ProcessRunner } from '../../src/runtime/runtime-api.js';
import { compactWorkGcCard } from '../helpers/work-gc-compaction.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gc-operation-')); roots.push(root); initProjectTree(root);
  compactWorkGcCard(root, TEST_WORKFLOWS);
  const path = join(root, '.saivage/work/cards/project/tmp/unselected');
  mkdirSync(join(root, '.saivage/work/cards/project/tmp'), { recursive: true }); writeFileSync(path, 'data');
  utimesSync(path, 1, 1);
  const loadEffective = jest.fn(() => ({ config: TEST_SAIVAGE_CONFIG, workflows: TEST_WORKFLOWS, warnings: [] }));
  const input: Parameters<typeof runWorkGcOperation>[0] = {
    request: { mode: 'dry_run' }, signal: new AbortController().signal,
    projectRoot: root, config: TEST_SAIVAGE_CONFIG, workflows: TEST_WORKFLOWS,
    configAuthority: { loadEffective } as unknown as ResolvedConfigAuthority,
    processRunner: { workGcProtection: () => ({ retainAll: false, capturePaths: [] }) } as unknown as ProcessRunner,
    fatalPort: { publicationOutcomeUnknown: error => { throw error; } },
    run: async ({ signal, inventory, collect, startObservation }) => {
      startObservation!();
      const found = await inventory(signal);
      try { return { value: await collect(found, signal), restoredRunning: true }; }
      catch (error) { throw new WorkGcMaintenanceError(true, error); }
    },
  };
  return { input, path, loadEffective };
}
it('composes fresh inputs with actual engine preview and deletion, preserving effect attribution', async () => {
  const { input, path, loadEffective } = fixture();
  const preview = await runWorkGcOperation(input);
  expect(preview).toMatchObject({ disposition: 'completed', restoration: 'resumed', failure: null,
    result: { would_delete_count: 1, deleted_count: 0 } });
  expect(WorkGcResponseSchema.safeParse(preview).success).toBe(true);
  expect(existsSync(path)).toBe(true);
  const deleted = await runWorkGcOperation({ ...input, request: { mode: 'delete' } });
  expect(deleted.result).toMatchObject({ would_delete_count: 0, deleted_count: 1, deleted_logical_bytes: 4 });
  expect(existsSync(path)).toBe(false);
  expect(loadEffective).toHaveBeenCalledTimes(2);
});
it('projects compiled shell hooks once, excludes raw scripts, and preserves literal args and MCP executable dependencies', async () => {
  const { input, loadEffective } = fixture(), config = structuredClone(TEST_SAIVAGE_CONFIG);
  const base = join(input.projectRoot, '.saivage/work/cards/project/tmp');
  for (const name of ['script-only.txt', 'literal', 'mcp-program', 'mcp-env']) {
    const path = join(base, name); writeFileSync(path, 'data'); utimesSync(path, 1, 1);
  }
  config.card_types.project!.workflow.after_activation_commit = {
    statuses: ['done'],
    execution: { kind: 'action', action: 'shell.run', contract_version: 1,
      config: { script: `cat ${join(base, 'script-only.txt')}`, cwd: 'action-scope' },
      inputs: { args: { literal: [join(base, 'literal')] } } },
  };
  config.mcpServers = { dependency: { format_version: 1, transport: 'stdio',
    command: join(base, 'mcp-program'), args: [], env: { CONFIG: 'report.md' }, disabled: false, autostart: false,
    policy: { controllerCardId: 'project', exposure: 'card' } } };
  symlinkSync(join(base, 'mcp-env'), join(input.projectRoot, 'report.md'));
  const workflows = compileProjectWorkflows(config);
  loadEffective.mockReturnValue({ config, workflows, warnings: [] });
  const result = await runWorkGcOperation({ ...input, config, workflows });
  expect(result).toMatchObject({ disposition: 'completed', result: {
    first_global_protection: null, would_delete_count: 2, retained: { protected: 3 },
  } });
});
it('refuses a required compiled cwd safely before selection, preserving actual restoration and cancellation precedence', async () => {
  const { input, path, loadEffective } = fixture(), config = structuredClone(TEST_SAIVAGE_CONFIG);
  const cwd = 'fixture-private-${name}';
  symlinkSync(join(input.projectRoot, 'missing-target'), join(input.projectRoot, cwd));
  config.card_types.project!.workflow.after_activation_commit = {
    statuses: ['done'], execution: { kind: 'action', action: 'shell.run', contract_version: 1,
      config: { script: 'echo fixture', cwd }, inputs: { args: { literal: [] } } },
  };
  const workflows = compileProjectWorkflows(config);
  loadEffective.mockReturnValue({ config, workflows, warnings: [] });
  for (const mode of ['dry_run', 'delete'] as const) {
    const response = await runWorkGcOperation({ ...input, config, workflows, request: { mode } });
    expect(WorkGcResponseSchema.parse(response)).toMatchObject({
      mode, disposition: 'refused', reason: 'reference_scope_unresolved', restoration: 'resumed',
      failure: { code: 'ENOENT' }, result: null,
    });
    expect(JSON.stringify(response)).not.toContain(cwd);
    expect(existsSync(path)).toBe(true);
  }
  expect(workGcFailureResponse({ mode: 'delete' }, new WorkGcMaintenanceError(
    true, new WorkGcReferenceScopeError(), true,
  ), 'collection_failed', true, 'resumed')).toMatchObject({
    disposition: 'refused', reason: 'cancelled', restoration: 'resumed', failure: null, result: null,
  });
});
it('refuses changed selected configuration without reconciling or deleting', async () => {
  const { input, path, loadEffective } = fixture();
  loadEffective.mockReturnValue({ config: { ...TEST_SAIVAGE_CONFIG,
    server: { ...TEST_SAIVAGE_CONFIG.server, port: 32123 } }, workflows: TEST_WORKFLOWS, warnings: [] });
  expect(await runWorkGcOperation({ ...input, request: { mode: 'delete' } })).toMatchObject({
    disposition: 'refused', reason: 'operational_inputs_invalid', restoration: 'resumed', result: null });
  expect(existsSync(path)).toBe(true);
});
it('carries process attribution through real collection, observations and owner settlement before completion', async () => {
  const { input, path } = fixture();
  const snapshots: WorkGcProgress[] = [];
  const mark = { reason: 'process_owner_uncertain', source: 'process_owner' } as const;
  let settled = false;
  const response = await runWorkGcOperation({ ...input,
    processRunner: { workGcProtection: () => ({ retainAll: true, capturePaths: [] }) } as unknown as ProcessRunner,
    progress: value => snapshots.push(value),
    run: async args => {
      const status = args.startObservation!();
      const found = await args.inventory(args.signal);
      const value = await args.collect(found, args.signal);
      expect(status()).toMatchObject({ phase: 'selection', first_global_protection: mark });
      settled = true;
      return { value, restoredRunning: false };
    },
  });
  expect(settled).toBe(true);
  expect(WorkGcResponseSchema.parse(response)).toMatchObject({ disposition: 'completed', result: {
    first_global_protection: mark, retained: { protected: 1 }, would_delete_count: 0 } });
  expect(snapshots.at(-1)).toMatchObject({ phase: 'selection', first_global_protection: mark });
  expect(existsSync(path)).toBe(true);
});
it('observes private-map workflow changes and does not treat empty enumerable maps as equal', async () => {
  const { input, path, loadEffective } = fixture();
  loadEffective.mockReturnValue({ config: TEST_SAIVAGE_CONFIG,
    workflows: { ...TEST_WORKFLOWS, operations: new Map() }, warnings: [] });
  expect(await runWorkGcOperation(input)).toMatchObject({ reason: 'operational_inputs_invalid' });
  expect(existsSync(path)).toBe(true);
});
it('keeps duplicate rejection distinct and reports owner cancellation/restoration without raw errors', async () => {
  const { input } = fixture();
  await expect(runWorkGcOperation({ ...input, run: async () => { throw new WorkGcBusyError(); } })).rejects.toBeInstanceOf(WorkGcBusyError);
  expect(await runWorkGcOperation({ ...input, run: async () => {
    throw new WorkGcMaintenanceError(false, new Error('private error text'), true);
  } })).toEqual({ mode: 'dry_run', disposition: 'refused', reason: 'cancelled', restoration: 'not_resumed', failure: null, result: null });
});
it('preserves known partial deletion and refuses hypothetical effects in delete reports', async () => {
  const { input } = fixture();
  const result = { mode: 'delete' as const, observed_count: 3, observed_logical_bytes: 11,
    opaque_entries: 0, whole_work_size_known: false as const, first_global_protection: null,
    retained: { protected: 0, recent: 0, stale: 0, opaque: 0, target: 0, below_min_file_bytes: 1 },
    would_delete_count: 0, would_delete_logical_bytes: 0, deleted_count: 1,
    deleted_logical_bytes: 4, expected_accounted_logical_bytes_remaining: 7,
    accounted_target_shortfall: null };
  const request = { mode: 'delete', min_file_bytes: 4 } as const;
  const response = await runWorkGcOperation({ ...input, request,
    run: async args => {
      args.startObservation!();
      await args.inventory(args.signal);
      throw new WorkGcMaintenanceError(false, new WorkGcInterruptedError(result, new Error('interrupted')), true);
    } });
  expect(response).toEqual({ mode: 'delete', disposition: 'interrupted', reason: 'cancelled',
    restoration: 'not_resumed', failure: null, result });
  expect(WorkGcResponseSchema.safeParse(response).success).toBe(true);
  expect(WorkGcResponseSchema.safeParse({ ...response, result: { ...result, would_delete_count: 1 } }).success).toBe(false);
  expect(workGcFailureResponse(request, new WorkGcMaintenanceError(false,
    new WorkGcInterruptedError(result, { code: 'EIO', syscall: 'read', path: 'SECRET' })),
    'collection_failed', false, 'not_resumed')).toEqual({ mode: 'delete', disposition: 'interrupted',
    reason: 'collection_failed', restoration: 'not_resumed', failure: { code: 'EIO', syscall: 'read' }, result });
});
it('delivers uncertainty to fatal before producing an ordinary refusal report', async () => {
  const { input } = fixture();
  const unknown = new PublicationOutcomeUnknownError(new Error('uncertain'));
  const terminal = new Error('fatal');
  const fatal = jest.fn((_error: PublicationOutcomeUnknownError): never => { throw terminal; });
  await expect(runWorkGcOperation({ ...input,
    fatalPort: { publicationOutcomeUnknown: fatal },
    run: async () => { throw unknown; },
  })).rejects.toBe(terminal);
  expect(fatal).toHaveBeenCalledWith(unknown);
});
it('supplies a fresh synchronous reservation observer only when the task accepts it', async () => {
  const { input } = fixture();
  for (const mode of ['dry_run', 'delete'] as const) {
    const completion = runWorkGcOperation({ ...input, request: { mode }, run: args => {
      const status = args.startObservation!();
      expect(status()).toMatchObject({ mode, phase: 'inventory', substep: 'starting',
        last_checkpoint_elapsed_ms: 0, first_global_protection: null });
      expect(status().counters).toEqual({});
      expect(() => runWorkGcOperation({ ...input, run() { throw new WorkGcBusyError(); } }))
        .toThrow(WorkGcBusyError);
      expect(status().mode).toBe(mode);
      return args.inventory(args.signal).then(found => {
        expect(status()).toMatchObject({ phase: 'settling', counters: { observed_count: 1 } });
        return args.collect(found, args.signal);
      }).then(value => ({ value, restoredRunning: false }));
    } });
    await expect(completion).resolves.toMatchObject({ mode, disposition: 'completed' });
  }
});

it.each(['direct', 'maintenance', 'interrupted'] as const)('projects only allowlisted original metadata through %s ownership', async owner => {
  const { input } = fixture();
  const result = (await runWorkGcOperation(input)).result!;
  const original = Object.assign(new Error('SECRET message', { cause: { code: 'EPERM', secret: 'SECRET cause' } }), {
    code: 'ENAMETOOLONG', syscall: 'lstat', stack: 'SECRET stack', path: 'SECRET path', dest: 'SECRET dest',
  });
  const error = owner === 'direct' ? original : new WorkGcMaintenanceError(true,
    owner === 'interrupted' ? new WorkGcInterruptedError(result, original) : original);
  const response = await runWorkGcOperation({ ...input, run: async () => { throw error; } });
  expect(response).toEqual({ mode: 'dry_run', disposition: owner === 'interrupted' ? 'interrupted' : 'refused',
    reason: 'inventory_failed', restoration: owner === 'direct' ? 'not_acquired' : 'resumed',
    failure: { code: 'ENAMETOOLONG', syscall: 'lstat' }, result: owner === 'interrupted' ? result : null });
  expect(WorkGcResponseSchema.parse(response)).toEqual(response);
});

it.each([
  [null, 'unknown', null], ['SECRET primitive', 'unknown', null], [42, 'unknown', null],
  [{ code: 'SECRET'.repeat(10000), syscall: 'SECRET'.repeat(10000) }, 'unknown', null],
  [{ code: ' EACCES', syscall: 'open' }, 'unknown', 'open'],
  [{ code: 'EIO', syscall: 'read SECRET' }, 'EIO', null],
  [{ cause: { code: 'EACCES', syscall: 'open' } }, 'unknown', null],
] as const)('does not infer or expose unrecognized metadata %#', (error, code, syscall) => {
  expect(workGcFailureResponse({ mode: 'dry_run' }, error, 'collection_failed', false, 'not_acquired'))
    .toEqual({ mode: 'dry_run', disposition: 'refused', reason: 'collection_failed', restoration: 'not_acquired',
      failure: { code, syscall }, result: null });
});

it('strictly requires the bounded failure shape and outcome consistency', async () => {
  const refusal = workGcFailureResponse({ mode: 'dry_run' }, { code: 'ENOENT', syscall: 'open' },
    'collection_failed', false, 'not_acquired');
  expect(WorkGcResponseSchema.parse(refusal)).toEqual(refusal);
  const { failure: _failure, ...missing } = refusal;
  const { input } = fixture();
  const completed = await runWorkGcOperation(input);
  const cancelled = { ...refusal, reason: 'cancelled', failure: null };
  expect(WorkGcResponseSchema.safeParse(cancelled).success).toBe(true);
  for (const invalid of [missing, { ...refusal, failure: null },
    { ...refusal, failure: { ...refusal.failure, path: 'SECRET' } },
    { ...refusal, failure: { code: 'PRIVATE', syscall: 'open' } },
    { ...refusal, failure: { code: 'EIO', syscall: 'PRIVATE' } },
    { ...completed, failure: refusal.failure }, { ...cancelled, failure: refusal.failure }]) {
    expect(WorkGcResponseSchema.safeParse(invalid).success).toBe(false);
  }
});
