import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { initProjectTree } from '../../helpers/canonical-project.js'; import { createTestProcessRunner } from '../../helpers/test-process-runner.js'; import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js'; import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';

const roots: string[] = []; afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function runtime(root: string, cards: CardService) { const changes = new ReadModelChangeBroadcaster(); return new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: root, processIdentity: { pid: 1, startedAt: 'now' }, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async (_input, signal) => new Promise<never>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, conversations: { projectRoot: root, changes }, readModelChanges: changes, processRunner: createTestProcessRunner(root), promptTemplates: createTestPromptTemplateRegistry() }); }

describe('Supervisor prepared-root recovery', () => {
  it('owns the root before leaf-to-root recovery publication and retains only root ownership for launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-recovery-')); roots.push(root); initProjectTree(root); const cards = new CardService(root);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'goal', brief: 'goal', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }); const leaf = cards.create({ type: 'code', parent: goal.id, title: 'leaf', brief: 'leaf', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(goal.id, 'running'); cards.setStatus(leaf.id, 'running'); const order: string[] = []; jest.spyOn(cards, 'stopRunningForRecovery').mockImplementation((id) => { order.push(id); return CardService.prototype.stopRunningForRecovery.call(cards, id); });
    const supervisor = runtime(root, cards); const prepared = await supervisor.beginStartProject(); expect(prepared.accepted).toBe(true); expect(order).toEqual([leaf.id, goal.id, 'project']); expect((supervisor as unknown as { activationOwners: Map<string, unknown> }).activationOwners.size).toBe(1); expect(supervisor.getStatus().status).toBe('starting');
    if (!prepared.accepted) throw new Error('rejected'); supervisor.launchStartedProject(prepared.launch); await supervisor.stopProject();
  });

  it('does not continue recovery writes after an outcome-unknown append and lets Stop clear locally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-recovery-unknown-')); roots.push(root); initProjectTree(root); const cards = new CardService(root); const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }); cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const stop = jest.spyOn(cards, 'stopRunningForRecovery').mockImplementationOnce(() => { throw new Error('unknown'); }); const supervisor = runtime(root, cards); const start = supervisor.beginStartProject(); await new Promise((resolve) => setImmediate(resolve)); expect(supervisor.getStatus().status).toBe('error'); expect(stop).toHaveBeenCalledTimes(1); stop.mockClear(); await supervisor.stopProject(); await expect(start).rejects.toBeInstanceOf(Error); expect(stop).not.toHaveBeenCalled();
  });
});
