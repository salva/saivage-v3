import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { startApp, type App } from '../../src/boot/app.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { CardService } from '../../src/cards/card-service.js';
import {
  appendConversationBatch,
  initializeMissingConversation,
  readConversation,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import {
  appLogFile,
  cardConversationVersionFile,
  cardConversationVersionIndexFile,
  cardRecordHeadFile,
  globalAgentConversationRoot,
  globalAgentConversationVersionFile,
  globalAgentConversationVersionIndexFile,
  runtimeProcessLockFile,
  saivageCardsRoot,
  saivageWorkRoot,
} from '../../src/persistence/layout.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { replaceConfigYaml } from '../../src/config/config-file.js';
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { agentMessageSchema, cardAgentSessionId } from '../../src/schemas/index.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { specializedCardTypes } from '../helpers/specialized-config.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import { buildGlobalAgentIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { toolCallRowPolicy } from '../helpers/row-policy-fixtures.js';
import { appendActivationMarker } from '../../src/runtime/actors/conversation-session.js';
import {
  appendStartupEvidence,
  appendStartupPendingCall,
} from '../helpers/startup-session-fixtures.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { cardHeadFile, providerExchangeFile } from '../../src/persistence/layout.js';
import { ModelRouter } from '../../src/agents/model-router.js';

const roots: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.stop();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('application startup generated-state admission', () => {
  it('is byte-stable for stopped heads, clean globals/evidence/log and an empty required index, without provider work', async () => {
    const root = projectRoot();
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.oversight.enabled = false;
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
    const workflows = compileProjectWorkflows(config);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    cards.setStatus('project', 'running');
    cards.stopRunning('project');
    const paths = [
      cardHeadFile(root, 'project'),
      cardConversationVersionIndexFile(root, 'project', 'reviewer'),
    ];
    for (const agentName of ['analyst', 'oversight'] as const) {
      const sessionId = `agent:${agentName}:global` as const;
      initializeMissingConversation(root, sessionId);
      appendConversationBatch(
        { projectRoot: root },
        buildGlobalAgentIngressRows(
          sessionId,
          '11111111-1111-4111-8111-111111111111',
          'pending text is not interruption',
        ),
      );
      const segment = readCurrentConversationSegment(root, sessionId)!;
      paths.push(
        globalAgentConversationVersionFile(root, agentName, segment.entry.filename),
        globalAgentConversationVersionIndexFile(root, agentName),
        appendStartupEvidence(root, sessionId),
      );
    }
    appendAppLogEntry(root, 'event', () => ({
      type: 'event',
      data: {
        id: 'clean-log',
        timestamp: '2026-10-03T00:00:00.000Z',
        kind: 'runtime_diagnostic',
        error_message: 'clean fixture',
      },
    }));
    paths.push(appLogFile(root));
    const before = paths.map((path) => readFileSync(path));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const activation = randomUUID();
    const app = await start(root, false, activation);
    apps.push(app);
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readCurrentConversationSegment(root, 'agent:reviewer:project')).toBeNull();
    expect(readFileSync(join(root, '.saivage/diagnostics/failed-provider-requests', activation, '.gitignore'), 'utf8')).toBe('*\n');
    const directory = join(root, '.saivage/diagnostics/failed-provider-requests', activation);
    writeFileSync(join(directory, 'private.png'), 'synthetic sensitive diagnostic body');
    symlinkSync(directory, join(root, 'private-diagnostic-alias'));
    for (const path of ['.saivage/diagnostics', `.saivage/diagnostics/failed-provider-requests/${activation}/private.png`, 'private-diagnostic-alias/private.png']) {
      for (const endpoint of ['files', 'files/content', 'files/image']) {
        const response = await app.server.fastify.inject({ url: `/api/${endpoint}?${new URLSearchParams({ path })}` });
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toContain('synthetic sensitive diagnostic body');
      }
    }
    const listing = await app.server.fastify.inject({ url: '/api/files?path=.saivage' });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().files.map((file: { name: string }) => file.name)).not.toContain('diagnostics');
  });

  it('ignores stray Oversight evidence when its optional exact index is absent', async () => {
    const root = projectRoot();
    publishInitialProjectRuntime(root, compileProjectWorkflows(TEST_SAIVAGE_CONFIG));
    const evidence = providerExchangeFile(root, 'agent:oversight:global');
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, '{"complete":"invalid"}\n');
    const before = readFileSync(evidence);
    const app = await start(root, false);
    apps.push(app);
    expect(readFileSync(evidence)).toEqual(before);
    expect(existsSync(globalAgentConversationVersionIndexFile(root, 'oversight'))).toBe(false);
  });
  it('admits a valid empty disabled Oversight index without publishing conversation state', async () => {
    const root = projectRoot();
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.oversight.enabled = false;
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
    publishInitialProjectRuntime(root, compileProjectWorkflows(config));
    initializeMissingConversation(root, 'agent:oversight:global');
    const index = globalAgentConversationVersionIndexFile(root, 'oversight');
    const before = readFileSync(index);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const app = await start(root, false);
    apps.push(app);
    expect(readFileSync(index)).toEqual(before);
    expect(readConversation(root, 'agent:oversight:global').physicalRows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed optional Oversight index before card correction or MCP', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    cards.setStatus('project', 'running');
    initializeMissingConversation(root, 'agent:oversight:global');
    const index = globalAgentConversationVersionIndexFile(root, 'oversight');
    writeFileSync(index, '{invalid');
    const correction = jest.spyOn(CardService.prototype, 'stopRunning');
    const reconcile = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig');
    await expect(start(root, false)).rejects.toThrow();
    expect(correction).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(readFileSync(index, 'utf8')).toBe('{invalid');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
  it.each([false, true])(
    'observes fresh Oversight establishment at composition after admission (initially %s)',
    async (initiallyEstablished) => {
      const root = projectRoot();
      const config = structuredClone(TEST_SAIVAGE_CONFIG);
      config.oversight.enabled = false;
      replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
      publishInitialProjectRuntime(root, compileProjectWorkflows(config));
      const sessionId = 'agent:oversight:global' as const;
      const index = globalAgentConversationVersionIndexFile(root, 'oversight');
      if (initiallyEstablished) initializeMissingConversation(root, sessionId);
      // Runtime route binding occurs in composition, after generated-state admission.
      // Change this exact test-owned index between those two independent reader calls.
      const resolveModels = ModelRouter.prototype.resolveModels;
      const binding = jest
        .spyOn(ModelRouter.prototype, 'resolveModels')
        .mockImplementationOnce(function (this: ModelRouter, ids, request) {
          expect(existsSync(index)).toBe(initiallyEstablished);
          if (initiallyEstablished) rmSync(index);
          else {
            initializeMissingConversation(root, sessionId);
            const inputId = '11111111-1111-4111-8111-111111111111';
            appendConversationBatch(
              { projectRoot: root },
              buildGlobalAgentIngressRows(sessionId, inputId, 'question'),
            );
            appendStartupPendingCall(root, sessionId, inputId);
          }
          return resolveModels.call(this, ids, request);
        });
      const app = await start(root, false);
      apps.push(app);
      expect(binding).toHaveBeenCalled();
      expect(existsSync(index)).toBe(!initiallyEstablished);
      if (!initiallyEstablished) {
        const conversation = readConversation(root, sessionId);
        expect(conversation.unmatchedCall).toBeNull();
        expect(conversation.physicalRows.at(-1)!.kind).toBe('tool_result');
      }
    },
  );
  it('consumes all running configured session tails before leaf-to-root correction, including the non-current reviewer', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Running child',
      bootstrap_content: 'brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const evidence = new Map<string, Buffer>();
    const paths: string[] = [];
    for (const [cardId, agentName, input] of [
      ['project', 'planner', '11111111-1111-4111-8111-111111111111'],
      ['project', 'reviewer', '22222222-2222-4222-8222-222222222222'],
      [child.id, 'executor', '33333333-3333-4333-8333-333333333333'],
    ] as const) {
      const sessionId = cardAgentSessionId(agentName, cardId);
      appendActivationMarker({ projectRoot: root }, sessionId, {
        event: 'activation_open',
        agent_name: agentName,
        card_id: cardId,
        input_id: input,
      });
      const segment = readCurrentConversationSegment(root, sessionId)!;
      paths.push(cardConversationVersionFile(root, cardId, agentName, segment.entry.filename));
      const path = appendStartupEvidence(root, sessionId);
      evidence.set(path, readFileSync(path));
      paths.push(path);
    }
    for (const path of paths) appendFileSync(path, '{"torn":');
    const stopped: string[] = [];
    const stopRunning = CardService.prototype.stopRunning;
    jest.spyOn(CardService.prototype, 'stopRunning').mockImplementation(function (
      this: CardService,
      id: string,
    ) {
      for (const [path, bytes] of evidence) expect(readFileSync(path)).toEqual(bytes);
      stopped.push(id);
      return stopRunning.call(this, id);
    });
    const app = await start(root, false);
    apps.push(app);
    expect(stopped).toEqual([child.id, 'project']);
    for (const path of paths) expect(readFileSync(path).at(-1)).toBe(10);
  });

  it('strictly consumes a formerly used stopped child without corrective append, retaining an unmatched call', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Stopped child',
      bootstrap_content: 'brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    cards.setStatus(child.id, 'running');
    const sessionId = cardAgentSessionId('executor', child.id);
    const input = '11111111-1111-4111-8111-111111111111';
    appendActivationMarker({ projectRoot: root }, sessionId, {
      event: 'activation_open',
      agent_name: 'executor',
      card_id: child.id,
      input_id: input,
    });
    appendStartupPendingCall(root, sessionId, input);
    const segment = readCurrentConversationSegment(root, sessionId)!;
    const conversationPath = cardConversationVersionFile(
      root,
      child.id,
      'executor',
      segment.entry.filename,
    );
    const evidencePath = appendStartupEvidence(root, sessionId);
    cards.stopRunning(child.id);
    const paths = [conversationPath, evidencePath];
    const before = paths.map((path) => readFileSync(path));
    const app = await start(root, false);
    apps.push(app);
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
    apps.pop();
    await app.stop();
    for (const path of paths) appendFileSync(path, '{"torn":');
    const restarted = await start(root, false);
    apps.push(restarted);
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
    expect(readConversation(root, sessionId).unmatchedCall?.toolCallId).toBe('pending');
    apps.pop();
    await restarted.stop();
    appendFileSync(conversationPath, '{"complete":"invalid"}\n');
    const invalid = readFileSync(conversationPath);
    expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow();
    await expect(start(root, false)).rejects.toThrow();
    expect(readFileSync(conversationPath)).toEqual(invalid);
  });
  it('reports safe advisory load warnings before initial runtime publication and still boots', async () => {
    const root = projectRoot();
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.providers.test!.apiKey =
      '${BATCH_F_SYNTHETIC_VALUE}${BATCH_F_MISSING}${ghp_SyntheticWarningName123}${github_pat_SyntheticWarningName123}${AKIA1234567890ABCDEF}';
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
    const diagnostics = jest.spyOn(console, 'error').mockImplementation(() => {
      expect(existsSync(saivageCardsRoot(root))).toBe(false);
    });
    const app = await startApp({
      projectRoot: root,
      createRuntime: true,
      env: {
        NODE_ENV: 'test',
        SAIVAGE_PORT: '0',
        SAIVAGE_HOST: '127.0.0.1',
        BATCH_F_SYNTHETIC_VALUE: 'distinctive-synthetic-env-value',
      },
    });
    apps.push(app);
    expect(diagnostics.mock.calls).toEqual([
      ["Configuration warning: Environment variable 'BATCH_F_MISSING' is not set."],
      ["Configuration warning: Environment variable 'ghp-[REDACTED]' is not set."],
      ["Configuration warning: Environment variable 'github_pat-[REDACTED]' is not set."],
      ["Configuration warning: Environment variable 'AKIA-[REDACTED]' is not set."],
    ]);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('distinctive-synthetic-env-value');
    expect(app.environment.config.providers.test!.apiKey).toBe('distinctive-synthetic-env-value');
    expect(Object.isFrozen(app.environment.configWarnings)).toBe(true);
    expect(app.server.fastify.server.address()).not.toBeNull();
    diagnostics.mockImplementation(() => {});
  });

  it('keeps strict configuration failure without emitting successful-load warnings or publishing runtime', async () => {
    const root = projectRoot();
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.providers.test!.apiKey = '${BATCH_F_MISSING}';
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), {
      ...config,
      unknown_contract: true,
    });
    const diagnostics = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(start(root, true)).rejects.toThrow(/Configuration validation failed/);
    expect(diagnostics).not.toHaveBeenCalled();
    expect(existsSync(saivageCardsRoot(root))).toBe(false);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('settles the interrupted chain before MCP reconciliation and retains correction after a later MCP failure', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    cards.setStatus('project', 'running');
    const reconcile = jest
      .spyOn(McpManager.prototype, 'reconcilePersistedConfig')
      .mockImplementation(async () => {
        expect(cards.read('project')!.lifecycle.status).toBe('stopped');
        throw new Error('MCP reconciliation probe failed');
      });
    const syncDisposal = jest.spyOn(SyncHub.prototype, 'dispose');
    const socketDisposal = jest.spyOn(LiveSyncSocket.prototype, 'dispose');

    await expect(start(root, false)).rejects.toThrow('MCP reconciliation probe failed');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(cards.read('project')!.lifecycle.status).toBe('stopped');
    expect(syncDisposal).toHaveBeenCalledTimes(1);
    expect(socketDisposal).toHaveBeenCalledTimes(1);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('rejects invalid linked topology before MCP reconciliation and disposes inert transports', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const cards = new CardService(root, workflows);
    const left = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Left',
      bootstrap_content: 'Left brief.',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const right = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Right',
      bootstrap_content: 'Right brief.',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    for (const id of ['project', left.id, right.id]) cards.setStatus(id, 'running');
    const reconcile = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig');
    const syncDisposal = jest.spyOn(SyncHub.prototype, 'dispose');
    const socketDisposal = jest.spyOn(LiveSyncSocket.prototype, 'dispose');

    await expect(start(root, false)).rejects.toThrow(
      'Startup interrupted-card settlement: linked-chain selection failed.',
    );
    expect(reconcile).not.toHaveBeenCalled();
    for (const id of ['project', left.id, right.id])
      expect(cards.read(id)!.lifecycle.status).toBe('running');
    expect(syncDisposal).toHaveBeenCalledTimes(1);
    expect(socketDisposal).toHaveBeenCalledTimes(1);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it.each(['analyst', 'oversight'] as const)(
    'settles an unmatched selected %s call before correcting an interrupted card and MCP',
    async (agentName) => {
      const root = projectRoot();
      if (agentName === 'oversight') {
        const config = structuredClone(TEST_SAIVAGE_CONFIG);
        config.oversight.enabled = false;
        replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);
      }
      const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
      publishInitialProjectRuntime(root, workflows);
      const cards = new CardService(root, workflows);
      cards.setStatus('project', 'running');
      const sessionId = `agent:${agentName}:global` as const;
      initializeMissingConversation(root, sessionId);
      const inputId = '11111111-1111-4111-8111-111111111111';
      const ingress = buildGlobalAgentIngressRows(sessionId, inputId, 'question');
      appendConversationBatch({ projectRoot: root }, ingress);
      appendConversationBatch({ projectRoot: root }, [
        {
          id: `${inputId}:tool-call:call-startup`,
          session_id: sessionId,
          role: 'assistant',
          kind: 'tool_call',
          tool: 'resume_runtime',
          tool_call_id: 'call-startup',
          context_policy: toolCallRowPolicy(),
          content: JSON.stringify({
            role: 'assistant',
            tool_calls: [
              {
                id: 'call-startup',
                type: 'function',
                function: { name: 'resume_runtime', arguments: '{}' },
              },
            ],
          }),
          round_id: `r-assistant-${inputId.replaceAll('-', '')}`,
          message_index: 3,
          block_index: 0,
          timestamp: ingress[1].timestamp,
        },
      ]);
      const segment = readCurrentConversationSegment(root, sessionId)!;
      const path = globalAgentConversationVersionFile(root, agentName, segment.entry.filename);
      const before = readFileSync(path);
      const evidencePath = appendStartupEvidence(root, sessionId);
      const evidenceBefore = readFileSync(evidencePath);
      appendFileSync(evidencePath, '{"torn":');
      const stopRunning = CardService.prototype.stopRunning;
      jest.spyOn(CardService.prototype, 'stopRunning').mockImplementation(function (
        this: CardService,
        id: string,
      ) {
        expect(readConversation(root, sessionId).unmatchedCall).toBeNull();
        return stopRunning.call(this, id);
      });
      const reconcile = jest
        .spyOn(McpManager.prototype, 'reconcilePersistedConfig')
        .mockImplementation(async () => {
          expect(cards.read('project')!.lifecycle.status).toBe('stopped');
          expect(readConversation(root, sessionId).physicalRows.at(-1)!.kind).toBe('tool_result');
          return { converged: true } as never;
        });
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const app = await start(root, false);
      apps.push(app);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(readFileSync(path).subarray(0, before.length)).toEqual(before);
      expect(readFileSync(evidencePath)).toEqual(evidenceBefore);
      expect(readConversation(root, sessionId).physicalRows.slice(segment.rows.length)).toEqual([
        expect.objectContaining({
          kind: 'tool_result',
          context_policy: expect.objectContaining({ settlement_origin: 'execution_failed' }),
        }),
      ]);
      const settled = readFileSync(path);
      apps.pop();
      await app.stop();
      const restarted = await start(root, false);
      apps.push(restarted);
      expect(readFileSync(path)).toEqual(settled);
    },
  );

  it('rejects missing indexed Oversight content rather than treating Oversight as absent', async () => {
    const root = projectRoot();
    publishInitialProjectRuntime(root, compileProjectWorkflows(TEST_SAIVAGE_CONFIG));
    initializeMissingConversation(root, 'agent:oversight:global');
    appendConversationBatch(
      { projectRoot: root },
      buildGlobalAgentIngressRows(
        'agent:oversight:global',
        '11111111-1111-4111-8111-111111111111',
        'check',
      ),
    );
    const segment = readCurrentConversationSegment(root, 'agent:oversight:global')!;
    rmSync(globalAgentConversationVersionFile(root, 'oversight', segment.entry.filename));
    const reconcile = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig');
    await expect(start(root, false)).rejects.toMatchObject({
      cause: { code: 'ENOENT' },
      message: expect.stringContaining(
        "Strict startup global conversation 'agent:oversight:global'",
      ),
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it.each(['analyst', 'planner'] as const)(
    'rejects a missing indexed required %s segment through unchanged canonical admission',
    async (agentName) => {
      const root = projectRoot();
      const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
      publishInitialProjectRuntime(root, workflows);
      const sessionId = agentName === 'analyst' ? 'agent:analyst:global' : 'agent:planner:project';
      if (agentName === 'analyst')
        appendConversationBatch(
          { projectRoot: root },
          buildGlobalAgentIngressRows(
            sessionId,
            '11111111-1111-4111-8111-111111111111',
            'question',
          ),
        );
      else
        appendActivationMarker({ projectRoot: root }, sessionId, {
          event: 'activation_open',
          agent_name: 'planner',
          card_id: 'project',
          input_id: '11111111-1111-4111-8111-111111111111',
        });
      const segment = readCurrentConversationSegment(root, sessionId)!;
      rmSync(
        agentName === 'analyst'
          ? globalAgentConversationVersionFile(root, agentName, segment.entry.filename)
          : cardConversationVersionFile(root, 'project', agentName, segment.entry.filename),
      );
      expect(() => initializeAndValidateCurrentGeneratedState(root, workflows)).toThrow();
      const reconcile = jest.spyOn(McpManager.prototype, 'reconcilePersistedConfig');
      await expect(start(root, false)).rejects.toMatchObject({
        cause: { code: 'ENOENT' },
        message: expect.stringContaining('Strict canonical missing state for current conversation'),
      });
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it('rejects a bare ordinary start before creating runtime layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-app-startup-bare-'));
    roots.push(root);
    await expect(start(root, false)).rejects.toThrow(/Project identity is missing/);
    expect(existsSync(join(root, '.saivage'))).toBe(false);
  });

  it('rejects ordinary start without project authority before optional effects and releases the lifecycle lock', async () => {
    const root = projectRoot();
    const workflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
    publishInitialProjectRuntime(root, workflows);
    const timestamp = '2026-08-14T00:00:00.000Z';
    appendConversationBatch({ projectRoot: root }, [
      agentMessageSchema.parse({
        id: 'activation',
        context_policy: { kind: 'structural', behavior: 'activation_boundary' },
        session_id: 'agent:analyst:global',
        role: 'system',
        kind: 'activity',
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'analyst',
          input_id: '00000000-0000-4000-8000-000000000001',
          timestamp,
        }),
        round_id: `r-pre-${'0'.repeat(32)}`,
        message_index: 0,
        block_index: 0,
        timestamp,
      }),
    ]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(
      root,
      'analyst',
      segment.entry.filename,
    );
    appendFileSync(conversationPath, 'unterminated');
    const conversationBytes = readFileSync(conversationPath);
    const globalIndexBytes = readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'));
    rmSync(saivageCardsRoot(root), { recursive: true });

    await expect(start(root, false, randomUUID())).rejects.toThrow(/Required project card authority is missing/);
    expect(existsSync(join(root, '.saivage/diagnostics'))).toBe(false);
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(
      existsSync(cardRecordHeadFile(root, 'project', testRecordDefinition('status.md', 'project'))),
    ).toBe(false);
    expect(readFileSync(globalAgentConversationVersionIndexFile(root, 'analyst'))).toEqual(
      globalIndexBytes,
    );
    expect(readFileSync(conversationPath)).toEqual(conversationBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('publishes initial runtime authority before unified admission when --create-runtime is explicit', async () => {
    const root = projectRoot();
    const app = await start(root, true);
    apps.push(app);
    expect(existsSync(saivageCardsRoot(root))).toBe(true);
    expect(
      existsSync(cardRecordHeadFile(root, 'project', testRecordDefinition('brief.md', 'project'))),
    ).toBe(true);
    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    expect(app.server.fastify.server.address()).not.toBeNull();
    apps.pop();
    await app.stop();
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it.each([
    { label: 'ordinary start', createRuntime: false },
    { label: 'existing-state start --create-runtime', createRuntime: true },
  ])(
    'rejects $label with a newly configured missing session before server-owned effects',
    async ({ createRuntime }) => {
      const root = projectRoot();
      const originalWorkflows = compileProjectWorkflows(TEST_SAIVAGE_CONFIG);
      publishInitialProjectRuntime(root, originalWorkflows);
      const cards = new CardService(root, originalWorkflows);
      const child = cards.create({
        type: 'code',
        parent: 'project',
        title: 'Retained child',
        bootstrap_content: 'Retained brief.',
        priority: 0,
        urgency: 'normal',
        created_by: 'analyst',
        depends_on: [],
      });
      const timestamp = '2026-08-14T00:00:00.000Z';
      const oldSessionId = cardAgentSessionId('executor', child.id);
      appendConversationBatch({ projectRoot: root }, [
        agentMessageSchema.parse({
          id: `executor-${createRuntime}`,
          context_policy: { kind: 'structural', behavior: 'activation_boundary' },
          session_id: oldSessionId,
          role: 'system',
          kind: 'activity',
          content: JSON.stringify({
            event: 'activation_open',
            agent_name: 'executor',
            card_id: child.id,
            input_id: '00000000-0000-4000-8000-000000000003',
            timestamp,
          }),
          round_id: `r-pre-${'2'.repeat(32)}`,
          message_index: 0,
          block_index: 0,
          timestamp,
        }),
      ]);
      const oldIndex = cardConversationVersionIndexFile(root, child.id, 'executor');
      const oldIndexBytes = readFileSync(oldIndex);
      const oldSegment = readCurrentConversationSegment(root, oldSessionId)!;
      const oldSegmentPath = cardConversationVersionFile(
        root,
        child.id,
        'executor',
        oldSegment.entry.filename,
      );
      const oldSegmentBytes = readFileSync(oldSegmentPath);
      const cardPath = join(
        root,
        '.saivage',
        'cards',
        'project',
        'children',
        'a',
        'card-head.json',
      );
      const cardBytes = readFileSync(cardPath);
      const changed = renamedExecutorConfig();
      replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), changed);
      const replacementIndex = cardConversationVersionIndexFile(root, child.id, 'executor-v2');
      const fetchSpy = jest.spyOn(globalThis, 'fetch');

      await expect(start(root, createRuntime)).rejects.toThrow(
        `Required conversation index for current configured session 'agent:executor-v2:${child.id}' is missing from initialized generated state. Startup will not create a replacement session.`,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(appLogFile(root))).toBe(false);
      expect(existsSync(saivageWorkRoot(root))).toBe(false);
      expect(existsSync(replacementIndex)).toBe(false);
      expect(readFileSync(oldIndex)).toEqual(oldIndexBytes);
      expect(readFileSync(oldSegmentPath)).toEqual(oldSegmentBytes);
      expect(readFileSync(cardPath)).toEqual(cardBytes);
      expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
    },
  );

  it('admits retained state after a never-used Oversight selection change and ignores unused declarations', async () => {
    const root = projectRoot();
    publishInitialProjectRuntime(root, compileProjectWorkflows(TEST_SAIVAGE_CONFIG));
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents['oversight-v2'] = { ...config.agents.oversight! };
    config.agents['unused-worker'] = { ...config.agents.executor! };
    config.oversight.agent = 'oversight-v2';
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), config);

    expect(existsSync(globalAgentConversationRoot(root, 'oversight'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'oversight-v2'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'unused-worker'))).toBe(false);
    const app = await start(root, false);
    apps.push(app);
    expect(app.server.fastify.server.address()).not.toBeNull();
    expect(existsSync(globalAgentConversationRoot(root, 'oversight-v2'))).toBe(false);
    expect(existsSync(globalAgentConversationRoot(root, 'unused-worker'))).toBe(false);
  });

  it('uses the same typed root and create intent for locking and environment loading', async () => {
    const root = projectRoot();
    const shadowedRoot = mkdtempSync(join(tmpdir(), 'saivage-app-shadowed-root-'));
    roots.push(shadowedRoot);
    const config = join(root, '.saivage', 'saivage.yaml');
    const app = await startApp({
      projectRoot: root,
      config,
      host: '127.0.0.1',
      port: '0',
      createRuntime: true,
      env: {
        NODE_ENV: 'test',
        SAIVAGE_PROJECT_ROOT: join(shadowedRoot, 'missing'),
        SAIVAGE_CONFIG: join(shadowedRoot, 'missing.yaml'),
        SAIVAGE_HOST: 'shadowed.invalid',
        SAIVAGE_PORT: 'malformed',
      },
    });
    apps.push(app);
    expect(app.environment).toMatchObject({
      projectRoot: root,
      server: { host: '127.0.0.1', port: 0 },
    });
    expect(existsSync(saivageCardsRoot(root))).toBe(true);
    expect(existsSync(join(shadowedRoot, '.saivage'))).toBe(false);
  });

  it('boots a newly published runtime with the explicit specialized compiled authority', async () => {
    const root = projectRoot();
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), selectedSpecializedConfig());
    cpSync(
      resolveSystemTemplate('classic-typed').promptRoot,
      join(root, '.saivage', 'config', 'prompts'),
      { recursive: true },
    );
    const app = await start(root, true);
    apps.push(app);
    expect(app.environment.config.card_types.test!.workflow.nodes).toHaveProperty('add-coverage');
    expect(app.environment.config.card_types.architecture!.workflow.nodes).toHaveProperty(
      'component-review',
    );
    expect(app.environment.config.card_types.architecture!.workflow.nodes).toHaveProperty(
      'system-review',
    );
    expect(app.environment.workflows.cardTypes.get('architecture')!.states).toHaveProperty('get');
    expect(
      app.environment.workflows.cardTypes.get('architecture')!.states.get('node:system-review'),
    ).toMatchObject({ kind: 'node', nodeId: 'system-review' });
  });

  it('fails startup on a present empty declared optional stream without changing it', async () => {
    const root = projectRoot();
    publishInitialProjectRuntime(root, compileProjectWorkflows(TEST_SAIVAGE_CONFIG));
    const stream = cardRecordHeadFile(
      root,
      'project',
      testRecordDefinition('status.md', 'project'),
    );
    writeFileSync(stream, '');
    await expect(start(root, false)).rejects.toThrow();
    expect(readFileSync(stream)).toEqual(Buffer.alloc(0));
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('rejects retained explicit-family authority after selecting standard before optional effects and releases the lifecycle lock', async () => {
    const root = projectRoot();
    const explicitConfig = explicitFixtureFamilyConfig();
    const explicitWorkflows = compileProjectWorkflows(explicitConfig);
    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), explicitConfig);
    publishInitialProjectRuntime(root, explicitWorkflows);
    new CardService(root, explicitWorkflows).create({
      type: 'fixture-leaf',
      parent: 'project',
      title: 'Fixture-family child',
      bootstrap_content: 'Fixture-family authority.',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    expect(() => initializeAndValidateCurrentGeneratedState(root, explicitWorkflows)).not.toThrow();

    replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), selectedStandardConfig());
    const timestamp = '2026-08-14T00:00:00.000Z';
    appendConversationBatch({ projectRoot: root }, [
      agentMessageSchema.parse({
        id: 'set-change',
        context_policy: { kind: 'structural', behavior: 'activation_boundary' },
        session_id: 'agent:analyst:global',
        role: 'system',
        kind: 'activity',
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'analyst',
          input_id: '00000000-0000-4000-8000-000000000002',
          timestamp,
        }),
        round_id: `r-pre-${'1'.repeat(32)}`,
        message_index: 0,
        block_index: 0,
        timestamp,
      }),
    ]);
    const segment = readCurrentConversationSegment(root, 'agent:analyst:global')!;
    const conversationPath = globalAgentConversationVersionFile(
      root,
      'analyst',
      segment.entry.filename,
    );
    appendFileSync(conversationPath, 'unterminated');
    const conversationBytes = readFileSync(conversationPath);

    await expect(start(root, false)).rejects.toThrow(
      /No compiled workflow exists for card type 'fixture-leaf'/,
    );
    expect(existsSync(appLogFile(root))).toBe(false);
    expect(
      existsSync(cardRecordHeadFile(root, 'project', testRecordDefinition('status.md', 'project'))),
    ).toBe(false);
    expect(readFileSync(conversationPath)).toEqual(conversationBytes);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-app-startup-'));
  roots.push(root);
  createProjectIdentity(root, 'Startup test');
  replaceConfigYaml(join(root, '.saivage', 'saivage.yaml'), TEST_SAIVAGE_CONFIG);
  return root;
}
function start(root: string, createRuntime: boolean, failedProviderDiagnostics?: string): Promise<App> {
  return startApp({
    projectRoot: root,
    createRuntime,
    failedProviderDiagnostics,
    env: { NODE_ENV: 'test', SAIVAGE_PORT: '0', SAIVAGE_HOST: '127.0.0.1' },
  });
}
function explicitFixtureFamilyConfig() {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  const project = config.card_types.project!;
  config.card_types.project = {
    ...project,
    permitted_child_types: [...project.permitted_child_types, 'fixture-leaf'],
  };
  config.card_types['fixture-leaf'] = structuredClone(config.card_types.code!);
  return effectiveSaivageConfigSchema.parse(config);
}
function selectedStandardConfig(): Record<string, unknown> {
  const config = structuredClone(TEST_SAIVAGE_CONFIG) as unknown as Record<string, unknown>;
  delete config['card_types'];
  return config;
}
function selectedSpecializedConfig(): Record<string, unknown> {
  const config = structuredClone(TEST_SAIVAGE_CONFIG) as unknown as Record<string, unknown>;
  config['card_types'] = specializedCardTypes();
  return config;
}
function renamedExecutorConfig() {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.agents['executor-v2'] = { ...config.agents.executor! };
  config.card_types.code!.workflow.notification_recipient = 'executor-v2';
  config.card_types.code!.workflow.nodes.execute!.agent = 'executor-v2';
  config.mcpServers = {
    admission_probe: {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
      autostart: true,
      disabled: false,
    },
  };
  return config;
}
