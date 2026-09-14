import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventQueryService } from '../../src/application/event-query-service.js';
import { createApplicationFatalPort } from '../../src/contracts/index.js';
import { SYSTEM_TEMPLATES, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import {
  compileProjectWorkflows,
  nodeResultToolDefinition,
  type CompiledCardTypeWorkflow,
} from '../../src/runtime/card-process/card-process-config.js';
import {
  buildRuntimeToolCatalog,
  type CardToolBindingContext,
  type GlobalToolBindingContext,
  type RuntimeToolBindingContext,
} from '../../src/tools/runtime-tool-catalog.js';
import { llmToolDefinition } from '../../src/tools/invocation.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardService, initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { createTestRestartPort } from '../helpers/restart-port.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function isObjectSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const root = schema as Readonly<Record<string, unknown>>;
  if (root.type === 'object') return true;
  return Array.isArray(root.anyOf) && root.anyOf.length > 0 && root.anyOf.every(isObjectSchema);
}

function expectObjectSchema(schema: Readonly<Record<string, unknown>>, surface: string): void {
  if (!isObjectSchema(schema)) throw new Error(`Converted schema root for '${surface}' is not an object schema.`);
}

function reachableNodeStateIds(workflow: CompiledCardTypeWorkflow): string[] {
  const pending = [workflow.initialStateId as string];
  const visited = new Set<string>();
  const nodes: string[] = [];

  while (pending.length > 0) {
    const stateId = pending.pop()!;
    if (visited.has(stateId)) continue;
    visited.add(stateId);
    const state = workflow.states.get(stateId);
    if (!state) throw new Error(`Workflow '${workflow.cardType}' references missing state '${stateId}'.`);
    if (state.kind === 'node') nodes.push(stateId);
    for (const transition of state.on.values()) pending.push(transition.targetStateId);
  }

  return nodes;
}

describe('zodToJsonSchemaMini production surface canary', () => {
  it('materializes every runtime tool and every reachable shipped-template node as an object schema', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-schema-canary-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);

    const store = new CardService(projectRoot);
    const processRegistry = new ManagedProcessGroupRegistry();
    const cardProcessScope = processRegistry.createDirectScope(processRegistry.rootScope, 'schema-canary-card', 'runtime_card');
    const globalProcessScope = processRegistry.createDirectScope(processRegistry.rootScope, 'schema-canary-global', 'operator_session');
    const processRunner = new ProcessRunner(projectRoot, processRegistry, createApplicationFatalPort());
    const cardTypeVocabulary = effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate('classic').config)).card_types;
    const vocabulary = Object.keys(cardTypeVocabulary) as Array<keyof typeof cardTypeVocabulary>;
    const mcpToolInvocation = {
      getServerTools: () => [],
      findToolCapability: () => null,
      invokeTool: async () => ({}),
    };
    const analystToolContext: ToolContext = {
      cardTypeVocabulary: vocabulary,
      projectRoot,
      configAuthority: testConfigAuthority(projectRoot),
      interventionReadiness: { assertInterventionReady() {} },
      processRunner,
      processScope: globalProcessScope,
      store,
      sessionId: 'agent:analyst:global',
      runtime: {
        startProject: async () => ({ runtime: null, status: 'stopped', started: false, stopped: true }),
        pause() {},
        resume() {},
        stopProject: async () => ({ status: 'stopped', contained: false }),
        notifyCard: (cardId) => ({ ok: false, reason: 'missing_card', cardId }),
        submitNotification: async (cardId) => ({ queued: false, reason: 'missing_card', cardId }),
        getStatus: () => ({ status: 'stopped', currentCardId: null, pid: process.pid, startedAt: new Date(0).toISOString() }),
      },
      mcpToolInvocation,
      restartCapability: { available: true, port: createTestRestartPort() },
      actor: 'analyst',
      surface: 'web-chat',
      eventQueries: new EventQueryService(projectRoot),
      captureExecutingLlmSnapshots: () => new Map(),
    };
    const globalContext: GlobalToolBindingContext = {
      scope: 'global',
      agentName: 'analyst',
      projectRoot,
      store,
      processRunner,
      processScope: globalProcessScope,
      processOwnerId: 'agent:analyst:global',
      mcpToolInvocation,
      analystToolContext,
      cardTypeVocabulary: vocabulary,
    };
    const cardContext: CardToolBindingContext = {
      scope: 'card',
      agentName: 'planner',
      projectRoot,
      store,
      cardId: 'project',
      sessionId: 'agent:planner:project',
      parentControl: {
        activateChild: async () => ({ status: 'cancelled', summary: 'schema canary does not execute tools' }),
        cancelChild: async ({ childCardId, reason }) => ({ card_id: childCardId, status: 'cancelled', cancelled_card_ids: [childCardId], reason }),
        reopenChild: ({ childCardId }) => ({ card_id: childCardId, status: 'changed' }),
      },
      childCreationTypes: new Set(vocabulary.filter((type) => type !== 'project')),
      childActivationTypes: new Set(vocabulary.filter((type) => type !== 'project')),
      cardTypeVocabulary: vocabulary,
      notifyCard: (cardId) => ({ ok: false, reason: 'missing_card', cardId }),
      submitNotification: async (cardId) => ({ queued: false, reason: 'missing_card', cardId }),
      processRunner,
      processScope: cardProcessScope,
      processOwnerId: 'activation-schema-canary',
      mcpToolInvocation,
    };

    const catalog = buildRuntimeToolCatalog();
    const coveredTools = new Set<string>();
    for (const entry of catalog.values()) {
      const key = `${entry.group.scope}/${entry.binder.name}`;
      expect(coveredTools.has(key)).toBe(false);
      coveredTools.add(key);
      const runtimeContext: RuntimeToolBindingContext = entry.group.scope === 'global' ? globalContext : cardContext;
      const definition = entry.binder.bind(entry.group.context(runtimeContext));
      expect(definition.name).toBe(entry.binder.name);
      expectObjectSchema(llmToolDefinition(definition).function.parameters, key);
    }
    expect(coveredTools.size).toBe(catalog.size);
    expect(coveredTools).toEqual(new Set([...catalog.values()].map((entry) => `${entry.group.scope}/${entry.binder.name}`)));

    expect(SYSTEM_TEMPLATES.map((template) => template.name)).toEqual(['classic', 'classic-typed']);
    const coveredNodes = new Set<string>();
    let expectedNodeCount = 0;
    for (const registeredTemplate of SYSTEM_TEMPLATES) {
      const template = resolveSystemTemplate(registeredTemplate.name);
      expect(template).toBe(registeredTemplate);
      const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
      const workflows = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot });
      for (const [cardType, workflow] of workflows.cardTypes) {
        const allNodeStateIds = [...workflow.states]
          .filter(([, state]) => state.kind === 'node')
          .map(([stateId]) => stateId);
        const reachableNodeIds = reachableNodeStateIds(workflow);
        expect(new Set(reachableNodeIds)).toEqual(new Set(allNodeStateIds));
        expectedNodeCount += allNodeStateIds.length;
        for (const stateId of reachableNodeIds) {
          const state = workflow.states.get(stateId)!;
          if (state.kind !== 'node') throw new Error(`Reachability walk returned non-node state '${stateId}'.`);
          const key = `${template.name}/${cardType}/${state.nodeId}`;
          expect(coveredNodes.has(key)).toBe(false);
          coveredNodes.add(key);
          expectObjectSchema(nodeResultToolDefinition(workflow, stateId).function.parameters, key);
        }
      }
    }
    expect(coveredNodes.size).toBe(expectedNodeCount);
  });
});
