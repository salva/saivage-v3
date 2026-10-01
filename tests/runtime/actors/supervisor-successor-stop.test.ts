import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { createAppTerminalCoordinator } from '../../../src/boot/app.js';
import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { CardProcessActor } from '../../../src/runtime/actors/card-process-actor.js';
import { ActivationOperationTracker } from '../../../src/runtime/actors/invocation-lifecycle.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Stop after an ordinary successful node', () => {
  it.each([
    ['microtask', 'Stop'], ['projection observer', 'Stop'],
    ['microtask', 'application close'], ['projection observer', 'application close'],
  ] as Array<['microtask' | 'projection observer', 'Stop' | 'application close']>)(
    'joins refused successor delivery at the %s boundary through %s', async (boundary, operation) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-successor-stop-'));
      roots.push(projectRoot);
      initProjectTree(projectRoot);
      const cards = new CardService(projectRoot);
      const processes = createTestProcessRunner(projectRoot);
      const timing: string[] = [];
      let providerCalls = 0;
      let successorObserved = false;
      let stopped!: Promise<unknown>;
      let signalStopped!: () => void;
      const stopEntered = new Promise<void>((resolve) => { signalStopped = resolve; });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const provider = scriptedAdmissionProvider(async () => {
        providerCalls++;
        if (providerCalls > 2) throw new Error('Successor provider must not run after Stop.');
        return {
          result: { kind: 'tool_calls' as const, tool_calls: [{
            id: `plan-${providerCalls}`, type: 'function' as const,
            function: providerCalls === 1
              ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'Plan ready for review.' }) }
              : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'admit_review', summary: 'Plan accepted.' }) },
          }] },
          provider_exchanges: [],
        };
      });
      const supervisor = createSupervisorRuntimeApi({
        ...testAutonomousCompaction,
        runtimeGate: new RuntimeGate(), projectRoot,
        processIdentity: { pid: 1, startedAt: '2026-10-02T00:00:00.000Z' },
        actorStore: cards, provider, conversations: { projectRoot },
        freshness: { ...NO_FRESHNESS_EFFECTS, agentMembershipChanged: () => {
          const current = owners().get('project');
          if (!successorObserved && current?.processor.processPosition().kind === 'node' &&
              current.processor.processPosition().stateId === 'node:review') {
            successorObserved = true;
            timing.push('successor transition');
            if (boundary === 'projection observer' && !stopped) stop();
          }
        } },
        processRunner: processes.processRunner,
        runtimeProcessRootScope: processes.runtimeProcessRootScope,
        promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
      });
      function owners(): Map<string, CardActivationOwner> {
        return (supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners;
      }
      function stop() {
        timing.push('Stop closes admission');
        // Observe rejection immediately, including the baseline empty-consumer failure.
        const coordinator = createAppTerminalCoordinator();
        coordinator.registerAdmissionCloser('runtime', () => supervisor.closeApplicationAdmission());
        coordinator.registerCleanupLeaf('runtime', () => supervisor.cleanupForApplicationStop());
        stopped = (operation === 'Stop' ? supervisor.stopProject() : coordinator.stop()).then(
          (result) => ({ result }), (error: unknown) => ({ error }),
        );
        signalStopped();
      }
      const execute = AgentNodeExecution.prototype.execute;
      const executions = jest.spyOn(AgentNodeExecution.prototype, 'execute').mockImplementation(function (this: AgentNodeExecution, args) {
        timing.push(`execute ${args.stateId}`);
        return execute.call(this, args).then((result) => {
          expect(result).toMatchObject({ nodeId: 'plan', outcome: 'admit_review' });
          timing.push('ordinary node succeeded');
          return result;
        });
      });
      const run = ActivationOperationTracker.prototype.run;
      jest.spyOn(ActivationOperationTracker.prototype, 'run').mockImplementation(function (this: ActivationOperationTracker, signal, work) {
        timing.push('task registration attempted');
        const wrapper = run.call(this, signal, work);
        if (boundary === 'microtask') {
          // Keep the original promise: this reaction runs before BaseActor's await resumes.
          // Stop runs one microtask later, after safeTask has accepted known success but
          // before actorMain can deliver it and synchronously dispatch the result event.
          void wrapper.then(() => {
            timing.push('successful wrapper settled');
            queueMicrotask(stop);
          }, () => undefined);
        }
        return wrapper;
      });
      const consume = ActivationOperationTracker.prototype.trackConsumer;
      jest.spyOn(ActivationOperationTracker.prototype, 'trackConsumer').mockImplementation(function (this: ActivationOperationTracker, callback) {
        timing.push('task consumer');
        return consume.call(this, callback);
      });
      const joinActivation = CardProcessActor.prototype.joinActivation;
      jest.spyOn(CardProcessActor.prototype, 'joinActivation').mockImplementation(function (this: CardProcessActor) {
        timing.push('activation join begins');
        return joinActivation.call(this).then(
          (result) => { timing.push('activation join finishes'); return result; },
          (error: unknown) => { timing.push('activation join finishes'); throw error; },
        );
      });

      expect((await supervisor.startProject()).started).toBe(true);
      await stopEntered;
      const outcome = await stopped;
      // Protect the takeover window and paired deliveries, not the entire pump trace.
      expect(timing.indexOf('ordinary node succeeded')).toBeLessThan(timing.indexOf('Stop closes admission'));
      const stopIndex = timing.indexOf('Stop closes admission');
      const transitionIndex = timing.indexOf('successor transition');
      if (boundary === 'microtask') {
        expect(stopIndex).toBeLessThan(timing.indexOf('task consumer'));
        expect(stopIndex).toBeLessThan(transitionIndex);
      } else {
        expect(transitionIndex).toBeLessThan(stopIndex);
      }
      expect(timing.filter((event) => event === 'task registration attempted')).toHaveLength(2);
      const consumers = timing.flatMap((event, index) => event === 'task consumer' ? [index] : []);
      expect(consumers).toHaveLength(2);
      expect(consumers[1]).toBeGreaterThan(stopIndex);
      expect(consumers[1]).toBeLessThan(timing.indexOf('activation join finishes'));
      expect(executions).toHaveBeenCalledTimes(1);
      expect(executions.mock.calls[0]![0].stateId).toBe('node:plan');
      expect(providerCalls).toBe(2);
      // Runner execution starts before session/record/scope preparation. No successor
      // execute call plus the untouched review record proves preparation was fenced.
      expect(cards.readRecordCurrent('project', 'review.md')).toMatchObject({ kind: 'found', value: { projection: null } });
      expect(readConversation(projectRoot, 'agent:planner:project').unmatchedCall).toBeNull();
      expect(outcome).toEqual({ result: operation === 'Stop' ? { status: 'stopped', contained: true } : { warnings: [] } });
      expect(errors).not.toHaveBeenCalled();
      expect(supervisor.getStatus().status).toBe('stopped');
      expect(owners().size).toBe(0);
    }, 10000,
  );
});
