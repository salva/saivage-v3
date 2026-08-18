import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { executedProviderResult } from '../../src/tools/invocation.js';
import { getAnalystControlToolBinders } from '../../src/tools/analyst-tool-registry.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(outcome: { kind: 'returned'; success: true; data: unknown } | { kind: 'denied'; reason: string }) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-reopen-tool-'));
  roots.push(projectRoot);
  const reopen = jest.fn(() => outcome);
  const assertInterventionReady = jest.fn();
  const context = {
    projectRoot,
    actor: 'analyst',
    surface: 'web-chat',
    interventionReadiness: { assertInterventionReady },
    analystMutations: { cards: { reopen } },
  } as unknown as ToolContext;
  const binder = getAnalystControlToolBinders().find((candidate) => candidate.name === 'reopen_card');
  if (!binder) throw new Error('missing reopen_card binder');
  return { projectRoot, reopen, assertInterventionReady, binder, tool: binder.bind(context) };
}

describe('Analyst reopen_card tool', () => {
  it('owns the exact strict schema and audited low-safety intervention-ready success path', async () => {
    const data = { card: { id: 'card-a', lifecycle: { status: 'changed' } }, status: 'changed' };
    const test = harness({ kind: 'returned', success: true, data });
    expect(test.tool.inputSchema.safeParse({ cardId: 'card-a' }).success).toBe(true);
    expect(test.tool.inputSchema.safeParse({ cardId: 'card-a', reason: 'legacy' }).success).toBe(false);

    await expect(test.tool.executor({ cardId: 'card-a' }, new AbortController().signal)).resolves.toEqual(executedProviderResult('none', { success: true, data }));
    expect(test.assertInterventionReady).toHaveBeenCalledTimes(1);
    expect(test.reopen).toHaveBeenCalledWith('card-a');
    expect(readAppLogEntries(test.projectRoot, 'control_action')).toEqual([
      expect.objectContaining({ type: 'control_action', data: expect.objectContaining({ action: 'card.reopen', safety_class: 'low', target_kind: 'card', target_id: 'card-a', outcome: 'ok' }) }),
    ]);
  });

  it('settles a wrong-state application denial without widening the lifecycle check', async () => {
    const test = harness({ kind: 'denied', reason: "card 'card-a' is running" });
    await expect(test.tool.executor({ cardId: 'card-a' }, new AbortController().signal)).resolves.toMatchObject({ providerResult: { success: false, data: { action: 'card.reopen', reason: "card 'card-a' is running" } }, evidence: { kind: 'none' } });
    expect(test.assertInterventionReady).toHaveBeenCalledTimes(1);
    expect(test.reopen).toHaveBeenCalledTimes(1);
    expect(readAppLogEntries(test.projectRoot, 'control_action')).toEqual([
      expect.objectContaining({ type: 'control_action', data: expect.objectContaining({ action: 'card.reopen', safety_class: 'low', target_id: 'card-a', outcome: 'denied' }) }),
    ]);
  });
});
