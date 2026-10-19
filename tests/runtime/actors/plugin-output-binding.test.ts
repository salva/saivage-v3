import { expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { CardService } from '../../../src/cards/card-service.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import {
  compileProjectWorkflows,
  bindRuntimeWorkflows,
} from '../../../src/runtime/card-process/card-process-config.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import type { OperationDefinition } from '../../../src/runtime/card-process/operation-contract.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import {
  scriptedAdmissionProvider,
  testAutonomousCompaction,
} from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

it.each([0, 3, -1])(
  'actual plugin output chooses a branch and binds typed successor input without retry: %i',
  async (count) => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-output-binding-'));
    let sourceCalls = 0;
    const selected: Array<{ label: string; input: unknown }> = [];
    const source: OperationDefinition = {
      id: 'fixture.inspect',
      provider: { kind: 'plugin', name: 'fixture' },
      contractVersion: 1,
      bindings: ['node'],
      config: z.object({}).strict(),
      inputs: {},
      outcomes: { finished: { count: { type: 'integer', min: 0, max: 1000, workflow: true } } },
      retainFields: ['count'],
      async run() {
        sourceCalls++;
        writeFileSync(join(root, 'known-effect.txt'), 'one known effect');
        return { outcome: 'finished', summary: 'Observed fixture count.', values: { count } };
      },
    };
    const consume: OperationDefinition = {
      id: 'fixture.consume',
      provider: { kind: 'plugin', name: 'fixture' },
      contractVersion: 1,
      bindings: ['node'],
      config: z.object({ label: z.string() }).strict(),
      inputs: { findings: { type: 'integer', min: 0, max: 1000, workflow: true } },
      outcomes: { consumed: {} },
      retainFields: [],
      async run(config, input) {
        selected.push({ label: (config as { label: string }).label, input });
        return { outcome: 'consumed', summary: 'Consumed actual bound count.', values: {} };
      },
    };
    const config = effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG));
    const workflow = config.card_types.project!.workflow;
    const recovery = workflow.nodes.plan!;
    workflow.entries.BACKLOG = { node: 'inspect' };
    workflow.entries.CHANGED = { node: 'inspect' };
    workflow.entries.BLOCKED = { node: 'plan' };
    workflow.entries.STOPPED = { ...workflow.entries.STOPPED, node: 'plan' };
    const terminal = {
      target: { terminal: 'BLOCKED' as const, promote: 'current' as const, export_records: [] },
    };
    workflow.nodes = {
      plan: {
        execution: recovery.execution,
        records: {},
        edges: { retry: { target: { node: 'inspect' } }, complete: terminal },
      },
      inspect: {
        execution: {
          kind: 'action',
          action: 'fixture.inspect',
          contract_version: 1,
          config: {},
          inputs: {},
        },
        records: {},
        edges: {
          finished: {
            cases: [
              {
                id: 'findings',
                when: { field: 'count', op: 'gt', value: 0 },
                target: { node: 'findings' },
                inputs: { findings: { output: 'count' } },
              },
            ],
            otherwise: { target: { node: 'empty' }, inputs: { findings: { output: 'count' } } },
          },
        },
      },
      ...Object.fromEntries(
        ['findings', 'empty'].map((label) => [
          label,
          {
            execution: {
              kind: 'action' as const,
              action: 'fixture.consume',
              contract_version: 1,
              config: { label },
              inputs: {},
            },
            records: {},
            edges: { consumed: terminal },
          },
        ]),
      ),
    };
    const compiled = compileProjectWorkflows(config, {
      operationPlugins: [{ namespace: 'fixture', operations: { inspect: source, consume } }],
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(
      compiled,
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
    );
    initProjectTree(root);
    const cards = new CardService(root, compiled);
    const processes = createTestProcessRunner(root);
    const provider = jest.fn(async () => {
      throw new Error('No agent turn is expected.');
    });
    const supervisor = createSupervisorRuntimeApi({
      ...testAutonomousCompaction,
      workflows,
      fatalPort: testApplicationFatalPort,
      runtimeGate: new RuntimeGate(),
      projectRoot: root,
      actorStore: cards,
      provider: scriptedAdmissionProvider(provider),
      conversations: { projectRoot: root },
      freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
      processRunner: processes.processRunner,
      runtimeProcessRootScope: processes.runtimeProcessRootScope,
      promptTemplates: createTestPromptTemplateRegistry(),
    });
    try {
      await supervisor.start();
      const internal = supervisor as unknown as {
        beginStartProject(): Promise<{
          accepted: boolean;
          launch: { owner: { settlement: { promise: Promise<unknown> } } };
        }>;
        launchStartedProject(plan: unknown): void;
      };
      const prepared = await internal.beginStartProject();
      if (!prepared.accepted) throw new Error('Fixture activation rejected.');
      const settlement = prepared.launch.owner.settlement.promise;
      internal.launchStartedProject(prepared.launch);
      if (count < 0) {
        await expect(settlement).resolves.toMatchObject({
          status: 'failed',
          result: { kind: 'runtime-failure' },
        });
        expect(selected).toEqual([]);
        expect(readCardExecutions(root, 'project').at(-1)).toMatchObject({
          disposition: 'unavailable',
          outcome: null,
          external_effects: 'unknown',
        });
      } else {
        await expect(settlement).resolves.toMatchObject({
          status: 'blocked',
          result: {
            executor: { kind: 'action', action: 'fixture.consume' },
            node_id: count ? 'findings' : 'empty',
          },
        });
        expect(selected).toEqual([
          { label: count ? 'findings' : 'empty', input: { findings: count } },
        ]);
      }
      expect(sourceCalls).toBe(1);
      expect(provider).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'known-effect.txt'), 'utf8')).toBe('one known effect');
    } finally {
      await supervisor.cleanupForApplicationStop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
