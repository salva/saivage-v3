import { EventBus } from '../../src/events/bus.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { AnalystRuntime, type AnalystRuntimeDeps } from '../../src/agents/analyst-api.js';
import type { SaivageConfig } from '../../src/agents/config-api.js';
import type { RuntimeApi } from '../../src/runtime/runtime-api.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createInvocationServiceProvider } from '../../src/application/micro-actor-runtime-api-factory.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { appendNotificationToActorSnapshot, cardActorId } from '../../src/runtime/actors/index.js';
import type { CardNotification } from '../../src/runtime/actors/index.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestPromptTemplateRegistry } from './prompt-template-registry.js';

const TEST_MODEL = 'test-analyst-model';

export function ensureTestSaivageConfig(projectRoot: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  mkdirSync(saivageDir, { recursive: true });
  writeFileSync(join(saivageDir, 'saivage.yaml'), YAML.stringify({
    models: { default: [TEST_MODEL], analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }));
}

export function loadTestConfig(projectRoot: string) {
  return loadEnvironment(['node', 'test', '--project-root', projectRoot], process.env).config;
}

export function createTestSaivageConfig(): SaivageConfig {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-test-config-'));
  ensureTestSaivageConfig(projectRoot);
  return loadTestConfig(projectRoot);
}

function testRuntimeTimestamp(): string { return new Date(0).toISOString(); }

function testRuntimeCommand(command: 'start_project' | 'stop_project'): Awaited<ReturnType<RuntimeApi['startProject']>>['command'] {
  return { command_id: `test-${command}`, command, status: command === 'start_project' ? 'accepted' : 'completed', requested_at: testRuntimeTimestamp(), completed_at: command === 'start_project' ? null : testRuntimeTimestamp(), source: 'runtime' };
}

interface TestAnalystRuntime {
  eventLogger?: AnalystRuntimeDeps['eventLogger'];
  candidateAvailability?: AnalystRuntimeDeps['candidateAvailability'];
  mcpManager?: AnalystRuntimeDeps['mcpManager'];
  emitAnalystToolInvoked(payload: Parameters<EventBus['emit']>[1]): void;
  setMcpManager(mcpManager: NonNullable<AnalystRuntimeDeps['mcpManager']>): void;
}

function createFlatTestAnalystRuntime(opts: { eventBus?: EventBus; cardStore?: CardStore; projectRoot?: string } = {}): TestAnalystRuntime & Pick<RuntimeApi, 'start' | 'shutdown' | 'pause' | 'resume' | 'notifyCard' | 'startProject' | 'stopProject' | 'subscribe' | 'getStatus' | 'getActorRuntimeReadModel'> {
  const eventBus = opts.eventBus ?? new EventBus();
  const runtime: TestAnalystRuntime & Pick<RuntimeApi, 'start' | 'shutdown' | 'pause' | 'resume' | 'notifyCard' | 'startProject' | 'stopProject' | 'subscribe' | 'getStatus' | 'getActorRuntimeReadModel'> = {
    eventLogger: undefined,
    candidateAvailability: undefined,
    mcpManager: undefined,
    async start(): Promise<void> {},
    async shutdown(): Promise<void> {},
    pause(): void {},
    resume(): void {},
    notifyCard(cardId: string, notification: CardNotification): ReturnType<RuntimeApi['notifyCard']> {
      if (!opts.cardStore || !opts.projectRoot) throw new Error('Test runtime notifyCard requires cardStore and projectRoot.');
      const card = opts.cardStore.read(cardId);
      if (!card) return { ok: false, reason: 'missing_card', cardId };
      appendNotificationToActorSnapshot(opts.projectRoot, cardActorId(cardId), notification);
      if (card.status === 'done' || card.status === 'failed' || card.status === 'needs_verification') {
        opts.cardStore.commitTerminalLifecyclePatch(cardId, {
          status: 'changed',
          lifecycle: { status: 'changed', result: card.lifecycle.result, error: card.lifecycle.error, completed_at: null },
        });
      }
      return { ok: true };
    },
    async startProject(): ReturnType<RuntimeApi['startProject']> {
      const timestamp = testRuntimeTimestamp();
      const command = testRuntimeCommand('start_project');
      return {
        success: true,
        command,
        run: { run_id: 'test-root-run', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', command_id: command.command_id, phase: 'planner', runtime_status: 'running', started_at: timestamp, updated_at: timestamp },
      };
    },
    async stopProject(): ReturnType<RuntimeApi['stopProject']> {
      const timestamp = testRuntimeTimestamp();
      const command = testRuntimeCommand('stop_project');
      return {
        success: true,
        command,
      };
    },
    subscribe: eventBus.subscribe.bind(eventBus),
    getStatus(): { status: 'stopped'; currentCardId: null; goalCount: 0; lastTickAt: null } { return { status: 'stopped', currentCardId: null, goalCount: 0, lastTickAt: null }; },
    getActorRuntimeReadModel() { return { pauseMode: 'running', activeWork: 'none', cards: [], agents: [], diagnostics: [], recovery: null } as const; },
    emitAnalystToolInvoked(payload: Parameters<EventBus['emit']>[1]): void {
      eventBus.emit('analyst_tool_invoked', payload as never);
    },
    setMcpManager(mcpManager: NonNullable<AnalystRuntimeDeps['mcpManager']>): void {
      this.mcpManager = mcpManager;
    },
  };
  return runtime;
}

export function createTestAnalystRuntime(opts: { eventBus?: EventBus; cardStore?: CardStore; projectRoot?: string; processRunner?: ProcessRunner } = {}): AnalystRuntimeDeps {
  const eventBus = opts.eventBus ?? new EventBus();
  const projectRoot = opts.projectRoot ?? mkdtempSync(join(tmpdir(), 'saivage-test-analyst-runtime-'));
  if (!opts.projectRoot) ensureTestSaivageConfig(projectRoot);
  const cardStore = opts.cardStore ?? new CardStore(projectRoot);
  const processRunner = opts.processRunner ?? new ProcessRunner(projectRoot);
  const analystRuntime = createFlatTestAnalystRuntime({ ...opts, eventBus, cardStore, projectRoot });
  const config = loadTestConfig(projectRoot);
  const availability = new MemoryCandidateAvailability();
  const registry = new ProviderRegistry(config);
  const invocationService = new InvocationService({
    projectRoot,
    saivageDir: join(projectRoot, '.saivage'),
    registry,
    router: new ModelRouter(config, registry, availability),
    candidateAvailability: availability,
  });
  return {
    runtime: analystRuntime,
    cardStore,
    candidateAvailability: analystRuntime.candidateAvailability,
    eventLogger: analystRuntime.eventLogger,
    eventBus,
    emitAnalystToolInvoked: (payload: Parameters<typeof analystRuntime.emitAnalystToolInvoked>[0]) => analystRuntime.emitAnalystToolInvoked(payload),
    provider: createInvocationServiceProvider(invocationService),
    processRunner,
    mcpManager: analystRuntime.mcpManager,
  };
}

export function createTestRuntimeApplication(opts: { eventBus?: EventBus; cardStore?: CardStore } = {}): RuntimeApplication {
  const eventBus = opts.eventBus ?? new EventBus();
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-test-runtime-app-'));
  ensureTestSaivageConfig(projectRoot);
  const cardStore = opts.cardStore ?? new CardStore(projectRoot);
  const processRunner = new ProcessRunner(projectRoot);
  const analystRuntime = createFlatTestAnalystRuntime({ ...opts, eventBus, cardStore, projectRoot });
  let analystRuntimeService: AnalystRuntime | null = null;
  const runtimeApplication: RuntimeApplication = {
    cardStore,
    processRunner,
    runtimeApi: {
      start: () => analystRuntime.start(),
      shutdown: () => analystRuntime.shutdown(),
      pause: () => analystRuntime.pause(),
      resume: () => analystRuntime.resume(),
      notifyCard: (cardId, notification) => analystRuntime.notifyCard(cardId, notification),
      startProject: (source) => analystRuntime.startProject(source),
      stopProject: (source) => analystRuntime.stopProject(source),
      subscribe: (options) => analystRuntime.subscribe(options),
      getStatus: () => analystRuntime.getStatus(),
      getActorRuntimeReadModel: () => analystRuntime.getActorRuntimeReadModel(),
    },
    get analystDeps() {
      const config = loadTestConfig(projectRoot);
      const availability = new MemoryCandidateAvailability();
      const registry = new ProviderRegistry(config);
      const invocationService = new InvocationService({
        projectRoot,
        saivageDir: join(projectRoot, '.saivage'),
        registry,
        router: new ModelRouter(config, registry, availability),
        candidateAvailability: availability,
      });
      return {
        runtime: analystRuntime,
        cardStore,
        candidateAvailability: analystRuntime.candidateAvailability,
        eventLogger: analystRuntime.eventLogger,
        eventBus,
        emitAnalystToolInvoked: (payload: Parameters<typeof analystRuntime.emitAnalystToolInvoked>[0]) => analystRuntime.emitAnalystToolInvoked(payload),
        provider: createInvocationServiceProvider(invocationService),
        processRunner,
        mcpManager: analystRuntime.mcpManager,
      };
    },
    get analystRuntime() {
      analystRuntimeService ??= new AnalystRuntime({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(projectRoot), config: loadTestConfig(projectRoot), runtimeDeps: this.analystDeps });
      return analystRuntimeService;
    },
    setAnalystRequestServerRestart(requestServerRestart) {
      this.analystRuntime.setRequestServerRestart(requestServerRestart);
    },
    getProviderRoutingReadModel: () => ({ providers: {} }),
    setMcpManager: (mcpManager) => analystRuntime.setMcpManager(mcpManager),
  };
  return runtimeApplication;
}
