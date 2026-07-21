import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import { AppLogPublicationError, readAppLogEntries } from '../../src/persistence/app-log.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), 'analyst-audit-order-')); roots.push(value); return value; }
function context(projectRoot: string): any {
  return {
    projectRoot, actor: 'analyst', surface: 'web-chat', interventionReadiness: { assertInterventionReady: jest.fn() },
    analystMutations: {},
  };
}
const spec = (mutate: () => any) => ({
  action: 'test.mutate', safety_class: 'low' as const, target_kind: 'runtime' as const,
  getTargetId: () => 'project', lifecycle: 'intervention_ready' as const, mutate,
});

describe('audited Analyst mutation publication ordering', () => {
  it('settles the mutation before preparing and appending its one audit row', async () => {
    const projectRoot = root(); const trace: string[] = [];
    const result = await runAuditedAnalystTool(context(projectRoot), {}, spec(() => { trace.push('mutation'); return { kind: 'result', success: true }; }));
    expect(result).toEqual({ success: true });
    expect(trace).toEqual(['mutation']);
    expect(readAppLogEntries(projectRoot, 'control_action')).toHaveLength(1);
  });

  it('lets audit publication failure win while retaining the exact mutation failure as operation context', async () => {
    const projectRoot = root(); writeFileSync(join(projectRoot, '.saivage'), 'not a directory');
    const mutationError = new Error('mutation failed');
    let thrown: unknown;
    try { await runAuditedAnalystTool(context(projectRoot), {}, spec(() => { throw mutationError; })); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLogPublicationError);
    expect(thrown).toMatchObject({ entryType: 'control_action', operationError: mutationError });
  });

  it('rethrows a pre-existing publication error without attempting a second audit', async () => {
    const projectRoot = root();
    const publicationError = new AppLogPublicationError('event', new Error('event append failed'));
    await expect(runAuditedAnalystTool(context(projectRoot), {}, spec(() => { throw publicationError; }))).rejects.toBe(publicationError);
    expect(readAppLogEntries(projectRoot)).toEqual([]);
  });
});
