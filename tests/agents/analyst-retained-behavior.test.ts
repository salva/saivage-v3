import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkspaceContextNote } from '../../src/agents/analyst-handler.js';
import { ANALYST_UNSUPPORTED_ACTION_TEMPLATE, runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import { executedToolOutcome } from '../../src/tools/invocation.js';
import { toolFailed, toolSucceeded } from '../../src/contracts/tool-result.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import { reorder_child } from '../../src/tools/analyst-card-tools.js';
import { queue_notification } from '../../src/tools/analyst-misc-tools.js';
import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { AnalystInterventionNotReadyError } from '../../src/application/intervention-readiness.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(options: { ready?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-audit-'));
  roots.push(root);
  const intervention = Object.freeze({
    assertInterventionReady() {
      if (options.ready === false) throw new Error('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
    },
  });
  const context = { projectRoot: root, actor: 'analyst', surface: 'web-chat', interventionReadiness: intervention, analystPreparation: {}, analystMutations: {} } as never;
  const spec = (mutate: (...args: any[]) => any, extra: Record<string, unknown> = {}) => ({ action: 'card.test', safety_class: 'low' as const, target_kind: 'card' as const, getTargetId: () => 'project', lifecycle: { kind: 'intervention_ready' as const, timing: 'immediate_before_mutation' as const }, mutate, ...extra });
  return { root, context, spec };
}

describe('Analyst retained navigation and capability behavior', () => {
  it('renders current workspace navigation without inventing focused state', () => {
    expect(buildWorkspaceContextNote()).toBe('[workspace-context] none — no entity is currently in focus');
    expect(buildWorkspaceContextNote({ view: 'cards', entityId: 'project', refinement: { tab: 'history', filter: 'failed' } })).toBe('[workspace-context]\nview: cards\nentity: project\nrefinement: tab=history;filter=failed');
  });

  it('keeps unsupported capability replies constrained to the registered catalog', () => {
    expect(ANALYST_UNSUPPORTED_ACTION_TEMPLATE('Navigate', ['open_card'])).toContain('Closest available capability: Navigate');
  });
});

describe('audited Analyst mutation settlement', () => {
  it('returns and audits the readiness-owner denial instead of escaping the tool boundary',async()=>{
    const test=harness();
    (test.context as any).interventionReadiness={assertInterventionReady(){throw new AnalystInterventionNotReadyError();}};
    const queue=jest.fn();
    (test.context as any).analystMutations={notifications:{queue}};
    const result=await queue_notification(test.context,{card_id:'project',kind:'finding',body:'context',urgency:'normal'},new AbortController().signal);
    expect(result.providerOutcome).toEqual({kind:'failed',error:'Analyst mutation requires an intervention-ready stopped or settled paused runtime.',data:{code:'intervention_not_ready'}});
    expect(queue).not.toHaveBeenCalled();
    expect(listControlActions(test.root)).toEqual([expect.objectContaining({action:'notification.queue',outcome:'denied',params_summary:expect.not.stringContaining('context')})]);
  });

  it('uses the production Analyst notification owner and shared snake-case body projection',async()=>{
    const test=harness();initProjectTree(test.root);
    const submit=jest.fn(async()=>({queued:true as const,cardId:'project',notificationId:'notice-analyst',interruption:{status:'not_requested' as const}}));
    (test.context as any).analystMutations=createAnalystMutationServices({store:new CardService(test.root),configAuthority:{} as never,notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),submitNotification:submit,cancelCard:async()=>{throw new Error('unused cancel');}});
    const result=await queue_notification(test.context,{card_id:'project',kind:'finding',body:'token=analyst-secret',urgency:'normal'},new AbortController().signal);
    expect(result.providerOutcome).toEqual({kind:'succeeded',data:{queued:true,card_id:'project',notification_id:'notice-analyst',body:'token=[REDACTED]',interruption:{status:'not_requested'}}});
    expect(submit).toHaveBeenCalledTimes(1);
    expect(listControlActions(test.root)).toEqual([expect.objectContaining({action:'notification.queue',outcome:'ok',params_summary:expect.not.stringContaining('analyst-secret')})]);
  });

  it('runs a supported destructive mutation once and preserves its audit classification', async () => {
    const test = harness();
    const mutate = jest.fn(() => ({ kind: 'returned' as const, success: true as const }));
    await expect(runAuditedAnalystTool(test.context, {}, { ...test.spec(mutate), safety_class: 'destructive' })).resolves.toEqual(executedToolOutcome('none', toolSucceeded()));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ actor: 'analyst', surface: 'web-chat', safety_class: 'destructive', outcome: 'ok' });
  });

  it('audits application denial after preparation exactly once', async () => {
    const test = harness();
    const result = await runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'denied', reason: 'status changed' }), { prepare: async () => ({ current: true }) }));
    expect(result.providerOutcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('status changed') });
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'denied' });
  });

  it('projects and audits a returned failure', async () => {
    const test = harness();
    const result = await runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'returned', success: false, error: 'owner rejected' })));
    expect(result).toEqual(executedToolOutcome('none', toolFailed('owner rejected')));
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error', error: 'owner rejected' });
  });

  it('audits preparation throws and rethrows the original error', async () => {
    const test = harness();
    const error = new Error('prepare failed');
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(jest.fn(), { prepare: async () => { throw error; } }))).rejects.toBe(error);
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error', error: 'prepare failed' });
  });

  it('audits application-owner disposal after preparation without calling the application owner', async () => {
    const test = harness();
    const controller = new AbortController();
    const mutate = jest.fn();
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate, { prepare: async () => { controller.abort(new Error('application disposed before mutation')); return {}; } }), controller.signal)).rejects.toThrow('application disposed before mutation');
    expect(mutate).not.toHaveBeenCalled();
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'error' });
  });

  it('audits readiness and application throws without calling twice', async () => {
    const readiness = harness({ ready: false });
    const mutate = jest.fn();
    await expect(runAuditedAnalystTool(readiness.context, {}, readiness.spec(mutate))).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    expect(listControlActions(readiness.root)).toHaveLength(1);

    const application = harness();
    const error = new Error('owner threw');
    const throwing = jest.fn(() => { throw error; });
    await expect(runAuditedAnalystTool(application.context, {}, application.spec(throwing))).rejects.toBe(error);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(listControlActions(application.root)[0]).toMatchObject({ outcome: 'error', error: 'owner threw' });
  });

  it('audits returned success once', async () => {
    const test = harness();
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(() => ({ kind: 'returned', success: true, data: { ok: true } })))).resolves.toEqual(executedToolOutcome('none', toolSucceeded({ ok: true })));
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'ok' });
  });

  it.each([
    { action: 'notification.queue', result: { kind: 'returned' as const, success: false as const, error: 'terminal_card' }, outcome: 'error' },
  ])('settles Analyst $action exactly once', async ({ action, result, outcome }) => {
    const test = harness();
    await runAuditedAnalystTool(test.context, {}, test.spec(() => result, { action }));
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ actor: 'analyst', action, outcome });
  });

  it('returns and audits an exported reorder_child zero-change success exactly once', async () => {
    const test = harness();
    const reorder = jest.fn(() => ({ kind: 'returned' as const, success: true as const, data: { parent_id: 'project', changed: 0 } }));
    (test.context as { analystMutations: unknown }).analystMutations = { cards: { reorder } };

    await expect(reorder_child(test.context, { parentId: 'project', orderedChildIds: [] })).resolves.toEqual(executedToolOutcome('none', toolSucceeded({ parent_id: 'project', changed: 0 })));
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith('project', []);
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ actor: 'analyst', action: 'card.reorder_child', outcome: 'ok' });
  });

  it('does not perform a post-mutation cancellation check after committed success', async () => {
    const test = harness();
    const controller = new AbortController();
    const mutate = jest.fn(async () => { controller.abort(new Error('operation owner disposed after commit')); return { kind: 'returned' as const, success: true as const }; });
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate), controller.signal)).resolves.toEqual(executedToolOutcome('none', toolSucceeded()));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(listControlActions(test.root)).toHaveLength(1);
    expect(listControlActions(test.root)[0]).toMatchObject({ outcome: 'ok' });
  });

  it('propagates audit append failure without another append attempt', async () => {
    const test = harness();
    mkdirSync(join(test.root, '.saivage', 'logs', 'app.jsonl'), { recursive: true });
    const mutate = jest.fn(() => ({ kind: 'returned' as const, success: true as const }));
    await expect(runAuditedAnalystTool(test.context, {}, test.spec(mutate))).rejects.toThrow();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
