import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkGcOperation } from '../../src/application/work-gc-operation.js';
import { WorkGcMaintenanceError, WorkGcResponseSchema, WorkGcBusyError, PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { WorkGcInterruptedError } from '../../src/workspace/index.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import type { ResolvedConfigAuthority } from '../../src/config/index.js';
import type { ProcessRunner } from '../../src/runtime/runtime-api.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gc-operation-')); roots.push(root); initProjectTree(root);
  const path = join(root, '.saivage/work/cards/project/tmp/unselected');
  mkdirSync(join(root, '.saivage/work/cards/project/tmp'), { recursive: true }); writeFileSync(path, 'data');
  const loadEffective = jest.fn(() => ({ config: TEST_SAIVAGE_CONFIG, workflows: TEST_WORKFLOWS, warnings: [] }));
  const input: Parameters<typeof runWorkGcOperation>[0] = {
    request: { mode: 'dry_run' }, signal: new AbortController().signal,
    projectRoot: root, config: TEST_SAIVAGE_CONFIG, workflows: TEST_WORKFLOWS,
    configAuthority: { loadEffective } as unknown as ResolvedConfigAuthority,
    processRunner: { workGcProtection: () => ({ retainAll: false, capturePaths: [] }) } as unknown as ProcessRunner,
    fatalPort: { publicationOutcomeUnknown: error => { throw error; } },
    run: async ({ signal, inventory, collect }) => {
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
  expect(preview).toMatchObject({ disposition: 'completed', restoration: 'resumed',
    result: { would_delete_count: 1, deleted_count: 0 } });
  expect(WorkGcResponseSchema.safeParse(preview).success).toBe(true);
  expect(existsSync(path)).toBe(true);
  const deleted = await runWorkGcOperation({ ...input, request: { mode: 'delete' } });
  expect(deleted.result).toMatchObject({ would_delete_count: 0, deleted_count: 1, deleted_logical_bytes: 4 });
  expect(existsSync(path)).toBe(false);
  expect(loadEffective).toHaveBeenCalledTimes(2);
});
it('refuses changed selected configuration without reconciling or deleting', async () => {
  const { input, path, loadEffective } = fixture();
  loadEffective.mockReturnValue({ config: { ...TEST_SAIVAGE_CONFIG,
    server: { ...TEST_SAIVAGE_CONFIG.server, port: 32123 } }, workflows: TEST_WORKFLOWS, warnings: [] });
  expect(await runWorkGcOperation({ ...input, request: { mode: 'delete' } })).toMatchObject({
    disposition: 'refused', reason: 'operational_inputs_invalid', restoration: 'resumed', result: null });
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
  } })).toEqual({ mode: 'dry_run', disposition: 'refused', reason: 'cancelled', restoration: 'not_resumed', result: null });
});
it('preserves known partial deletion and refuses hypothetical effects in delete reports', async () => {
  const { input } = fixture();
  const result = { mode: 'delete' as const, observed_count: 2, observed_logical_bytes: 8,
    opaque_entries: 0, whole_work_size_known: false as const,
    retained: { protected: 0, recent: 0, stale: 0, opaque: 0, target: 0 },
    would_delete_count: 0, would_delete_logical_bytes: 0, deleted_count: 1,
    deleted_logical_bytes: 4, expected_accounted_logical_bytes_remaining: 4,
    accounted_target_shortfall: null };
  const response = await runWorkGcOperation({ ...input, request: { mode: 'delete' },
    run: async args => {
      await args.inventory(args.signal);
      throw new WorkGcMaintenanceError(false, new WorkGcInterruptedError(result, new Error('interrupted')), true);
    } });
  expect(response).toEqual({ mode: 'delete', disposition: 'interrupted', reason: 'cancelled',
    restoration: 'not_resumed', result });
  expect(WorkGcResponseSchema.safeParse(response).success).toBe(true);
  expect(WorkGcResponseSchema.safeParse({ ...response, result: { ...result, would_delete_count: 1 } }).success).toBe(false);
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
