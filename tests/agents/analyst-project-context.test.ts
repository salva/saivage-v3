import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystSession } from '../../src/runtime/actors/analyst-session.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import type { CardService as CardServiceType } from '../../src/cards/store-api.js';
import { surfaceToolDefinitions, type InvocationSurface } from '../../src/tools/invocation.js';
import { BoundAgentToolSet, surfaceToolContracts } from '../../src/tools/runtime-tool-catalog.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { formatVocabularySnippet } from '../../src/tools/prompt-api.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { sha256Hex } from '../../src/schemas/index.js';
import {
  scriptedAdmissionProvider,
  testCompactionPolicy,
  testCompactor,
  unusedSummarizerProvider,
} from '../helpers/llm-test-helpers.js';
import { ANALYST_ORIENTATION_MAX_BYTES } from '../../src/application/read-models/analyst-orientation.js';
import { readConversation } from '../../src/persistence/conversation-file.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const runtimeCurrent = () => ({ status: 'stopped' as const, currentCardId: null });

function buildSession(
  projectRoot: string,
  cardStore: CardServiceType,
  completeTurn: ReturnType<typeof jest.fn>,
  render: ReturnType<typeof jest.fn>,
  surface: InvocationSurface = { agentName: 'analyst', tools: new Map(), providers: [] },
): AnalystSession {
  return new AnalystSession({
    cardTypeVocabulary: ['project', 'goal'],
    sessionId: 'agent:analyst:global',
    agentName: 'analyst',
    modelParams: { temperature: 0, maxTokens: 1000 },
    capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    routeUsableInputTokens: 80_000,
    promptTemplates: { render },
    restartCapability: { available: false },
    provider: scriptedAdmissionProvider(completeTurn),
    conversations: { projectRoot },
    compactionPolicy: testCompactionPolicy,
    compactor: {
      shouldCompact: () => false,
      compact: async () => {
        throw new Error('compaction must not run');
      },
    },
    summarizerProvider: unusedSummarizerProvider,
    cardStore,
    runtimeCurrent,
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses: async () => {},
    fatalPort: testApplicationFatalPort,
  });
}

describe('Analyst project context', () => {
  it('prepares the selected global role and compiled tool authority again on a later submission', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-selected-composition-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const cardTypeVocabulary = [...TEST_WORKFLOWS.cardTypes.keys()];
    const prompts = createTestPromptTemplateRegistry();
    const processes = new ManagedProcessGroupRegistry();
    const surface = new BoundAgentToolSet(TEST_WORKFLOWS.analyst.tools).bind({
      scope: 'global',
      agentName: TEST_WORKFLOWS.analyst.name,
      projectRoot,
      store,
      processRunner: {} as never,
      processScope: processes.createDirectScope(
        processes.rootScope,
        'analyst-composition',
        'operator_session',
      ),
      processOwnerId: 'agent:analyst:global',
      mcpToolInvocation: {} as never,
      analystToolContext: {
        projectRoot,
        store,
        restartCapability: { available: false },
        actor: 'analyst',
        surface: 'web-chat',
        cardTypeVocabulary,
        runtime: {},
        captureExecutingLlmSnapshots: () => new Map(),
      } as never,
      observationToolContext: {
        agentName: TEST_WORKFLOWS.analyst.name,
        projectRoot,
        store,
        processRunner: {} as never,
        eventQueries: {} as never,
        runtime: {} as never,
        queueNotification: async () => {
          throw new Error('no notification expected');
        },
        captureExecutingLlmSnapshots: () => new Map(),
      },
      cardTypeVocabulary,
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (input) => {
      calls++;
      const expectedRole = prompts.render({ kind: 'global-agent' }, TEST_WORKFLOWS.analyst.name, {
        vocabularySnippet: formatVocabularySnippet(cardTypeVocabulary),
      });
      expect(input.systemPrompt).toBe(expectedRole);
      expect(input.tools).toEqual(surfaceToolDefinitions(surface));
      expect(input.tools.map((tool) => tool.function.name)).toEqual(
        TEST_WORKFLOWS.analyst.tools.map((tool) => tool.name),
      );
      expect(input.compiledToolContracts).toEqual(surfaceToolContracts(surface));
      expect(input.preparedContext!.prefix.instructionText).toBe(expectedRole);
      expect(input.preparedContext!.stableBlocks.map((block) => block.id)).toEqual([
        'analyst.project_tree',
        'analyst.workspace_focus',
      ]);
      const directory = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, `analyst-submission-${calls}.json`),
          JSON.stringify(
            {
              agentName: input.agentName,
              sessionId: input.sessionId,
              systemPrompt: input.systemPrompt,
              tools: input.tools,
              compiledToolContracts: input.compiledToolContracts,
              preparedContext: input.preparedContext,
              providerConversation: input.providerConversation,
            },
            null,
            2,
          ),
        );
      }
      return {
        result: { kind: 'message' as const, content: 'Inspection complete.' },
        provider_exchanges: [],
      };
    });
    const session = new AnalystSession({
      cardTypeVocabulary,
      sessionId: 'agent:analyst:global',
      agentName: TEST_WORKFLOWS.analyst.name,
      modelParams: { temperature: 0, maxTokens: 1000 },
      capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
      candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      routeUsableInputTokens: 80_000,
      promptTemplates: prompts,
      restartCapability: { available: false },
      provider,
      conversations: { projectRoot },
      compactionPolicy: testCompactionPolicy,
      compactor: testCompactor,
      summarizerProvider: unusedSummarizerProvider,
      cardStore: store,
      runtimeCurrent,
      runtimeProjectionChanged() {},
      createInvocationSurface: () => surface,
      shutdownProcesses: async () => {},
      fatalPort: testApplicationFatalPort,
    });
    await session.submit({ userContent: 'Inspect the project.' });
    await session.submit({ userContent: 'Inspect it again.' });
    expect(calls).toBe(2);
  });

  it('derives the bounded orientation snapshot from one validated list without per-card parent reads', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-project-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    const child = persisted.create({
      type: 'goal',
      parent: 'project',
      title: 'Child',
      bootstrap_content: 'brief',
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const retained = persisted.create({
      type: 'goal',
      parent: 'project',
      title: 'Retained tombstone',
      bootstrap_content: 'brief',
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const second = persisted.create({
      type: 'goal',
      parent: 'project',
      title: 'Second',
      bootstrap_content: 'brief',
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    persisted.deleteSubtrees([retained.id], () => true, 'analyst');
    persisted.reorderChildren('project', [second.id, child.id]);
    const listed = persisted.list();
    const list = jest.fn(() => listed);
    const getParent = jest.fn(() => {
      throw new Error('parent lookup must not run');
    });
    const cardStore = { list, getParent } as unknown as CardServiceType;
    const providerInputs: unknown[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });
    const render = jest.fn(() => 'rendered prompt');

    await expect(
      buildSession(projectRoot, cardStore, completeTurn, render).submit({
        userContent: 'inspect cards',
      }),
    ).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    expect(list).toHaveBeenCalledTimes(1);
    expect(getParent).not.toHaveBeenCalled();
    const input = providerInputs[0] as {
      preparedContext: { stableBlocks: ReadonlyArray<{ id: string; content: string }> };
      providerConversation: {
        messages: ReadonlyArray<{
          kind: string;
          origin?: string;
          block_identity?: string;
          content: string;
        }>;
      };
    };
    const tree = input.preparedContext.stableBlocks[0]!;
    expect(tree.id).toBe('analyst.project_tree');
    expect(Buffer.byteLength(tree.content, 'utf8')).toBeLessThanOrEqual(
      ANALYST_ORIENTATION_MAX_BYTES,
    );
    const snapshot = JSON.parse(tree.content) as {
      root: { id: string; children?: Array<{ id: string }> };
      active_path: string[];
    };
    expect(snapshot.root.id).toBe('project');
    expect(snapshot.root.children?.map((node) => node.id)).toEqual([second.id, child.id]);
    expect(snapshot.active_path).toEqual([]);
    expect(
      input.providerConversation.messages.filter(
        (item) =>
          item.kind === 'synthetic_context' &&
          item.origin === 'dynamic' &&
          item.block_identity === tree.id &&
          item.content === tree.content,
      ),
    ).toHaveLength(1);
  });

  it('freezes the prepared invocation context with the project-tree dynamic block before ingress', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-prepared-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const persisted = new CardService(projectRoot);
    persisted.create({
      type: 'goal',
      parent: 'project',
      title: 'Child',
      bootstrap_content: 'brief',
      priority: 1,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const render = jest.fn(() => 'rendered prompt');
    const providerInputs: unknown[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });

    await expect(
      buildSession(projectRoot, persisted, completeTurn, render).submit({
        userContent: 'inspect cards',
      }),
    ).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    const input = providerInputs[0] as {
      systemPrompt: string;
      providerConversation: {
        messages: ReadonlyArray<{
          kind: string;
          origin?: string;
          block_identity?: string;
          content: string;
        }>;
      };
      preparedContext: {
        prefix: { instructionText: string; terminalToolNames: readonly string[] };
        stableBlocks: ReadonlyArray<{
          id: string;
          content: string;
          storage: string;
          replacement: { kind: string; key: string; contentSha256: string };
        }>;
        preparedCompaction: unknown;
      };
    };
    expect(input.systemPrompt).toBe('rendered prompt');
    expect(input.preparedContext.prefix.instructionText).toBe('rendered prompt');
    expect(input.preparedContext.prefix.terminalToolNames).toEqual([]);
    expect(input.preparedContext.stableBlocks).toHaveLength(2);
    expect(input.preparedContext.stableBlocks[1]).toMatchObject({
      id: 'analyst.workspace_focus',
      storage: 'activation_local',
      audience: 'primary_and_summarizer',
    });
    const focus = input.preparedContext.stableBlocks[1]!;
    expect(
      input.providerConversation.messages.filter(
        (item) =>
          item.kind === 'synthetic_context' &&
          item.origin === 'dynamic' &&
          item.block_identity === focus.id &&
          item.content === focus.content,
      ),
    ).toHaveLength(1);
    const tree = input.preparedContext.stableBlocks[0]!;
    expect(tree.id).toBe('analyst.project_tree');
    expect(tree.storage).toBe('activation_local');
    expect(tree.replacement.kind).toBe('latest_snapshot');
    expect(tree.replacement.key).toBe('analyst.project_tree');
    expect(tree.replacement.contentSha256).toBe(sha256Hex(tree.content));
    expect(
      input.providerConversation.messages.filter(
        (item) =>
          item.kind === 'synthetic_context' &&
          item.block_identity === tree.id &&
          item.content === tree.content,
      ),
    ).toHaveLength(1);
  });

  it('refreshes focus on the next submission while keeping each prepared snapshot out of canonical source rows', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-focus-refresh-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const listed = store.list();
    const list = jest.fn(() => listed);
    const providerInputs: any[] = [];
    const completeTurn = jest.fn(async (input: unknown) => {
      providerInputs.push(input);
      return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
    });
    const session = buildSession(
      projectRoot,
      { list } as unknown as CardServiceType,
      completeTurn,
      jest.fn(() => 'prompt'),
    );
    await session.submit({
      userContent: 'this card',
      workspaceContext: { view: 'cockpit', entityId: 'project', refinement: { tab: 'overview' } },
    });
    const first = providerInputs[0].preparedContext.stableBlocks[1].content;
    expect(JSON.parse(first).focus).toMatchObject({
      card_id: 'project',
      version_seq: listed[0]!.version_seq,
    });
    listed[0]!.version_seq += 1;
    await session.submit({
      userContent: 'still this card',
      workspaceContext: { view: 'cockpit', entityId: 'project', refinement: { tab: 'overview' } },
    });
    const second = providerInputs[1].preparedContext.stableBlocks[1].content;
    expect(JSON.parse(second).focus.version_seq).toBe(JSON.parse(first).focus.version_seq + 1);
    await session.submit({ userContent: 'no focus' });
    expect(JSON.parse(providerInputs[2].preparedContext.stableBlocks[1].content).focus).toBe(
      'no_focus',
    );
    expect(list).toHaveBeenCalledTimes(3);
    const rows = readConversation(projectRoot, 'agent:analyst:global').sourceRows;
    expect(rows.filter((row) => row.role === 'user').map((row) => row.content)).toEqual([
      'this card',
      'still this card',
      'no focus',
    ]);
    expect(rows.some((row) => row.content.includes('workspace_focus'))).toBe(false);
  });
});
