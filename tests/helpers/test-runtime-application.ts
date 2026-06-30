import { EventBus } from '../../src/events/bus.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import type { AnalystRuntimeDeps } from '../../src/agents/analyst-api.js';
import type { RuntimeApi } from '../../src/runtime/runtime-api.js';
import type { RoundStamp } from '../../src/runtime/session-stamper.js';
import { generateRoundId } from '../../src/schemas/round-id-server.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createInvocationServiceProvider } from '../../src/application/micro-actor-runtime-api-factory.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { loadConfig } from '../../src/agents/config-schema.js';

const TEST_MODEL = 'test-analyst-model';

function ensureTestSaivageConfig(projectRoot: string): void {
  const saivageDir = join(projectRoot, '.saivage');
  mkdirSync(saivageDir, { recursive: true });
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify({
    models: { analyst: [TEST_MODEL] },
    providers: { test: { models: [TEST_MODEL], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
  }, null, 2));
}

interface TestRoundState { currentRoundId: string | null; nextMessageIndex: number; nextBlockIndex: number; }

type TestAnalystRuntime = RuntimeApi & AnalystRuntimeDeps['stamper'] & {
  eventLogger?: AnalystRuntimeDeps['eventLogger'];
  candidateAvailability?: AnalystRuntimeDeps['candidateAvailability'];
  mcpManager?: AnalystRuntimeDeps['mcpManager'];
  emitAnalystToolInvoked(payload: Parameters<EventBus['emit']>[1]): void;
  setMcpManager(mcpManager: NonNullable<AnalystRuntimeDeps['mcpManager']>): void;
};

function testRuntimeTimestamp(): string { return new Date(0).toISOString(); }

function testRuntimeCommand(command: 'start_project' | 'stop_project'): Awaited<ReturnType<RuntimeApi['startProject']>>['command'] {
  return { command_id: `test-${command}`, command, status: 'completed', requested_at: testRuntimeTimestamp(), completed_at: testRuntimeTimestamp(), source: 'runtime' };
}

function createFlatTestAnalystRuntime(opts: { eventBus?: EventBus } = {}): TestAnalystRuntime {
  const eventBus = opts.eventBus ?? new EventBus();
  const states = new Map<string, TestRoundState>();
  const stateFor = (sessionId: string): TestRoundState => {
    let state = states.get(sessionId);
    if (!state) {
      state = { currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0 };
      states.set(sessionId, state);
    }
    return state;
  };
  const runtime: TestAnalystRuntime = {
    eventLogger: undefined,
    candidateAvailability: undefined,
    mcpManager: undefined,
    async start(): Promise<void> {},
    async shutdown(): Promise<void> {},
    pause(): void {},
    resume(): void {},
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
    openAssistantRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = generateRoundId('assistant');
      state.nextMessageIndex = 0;
      state.nextBlockIndex = 0;
      return this.stampInRound(sessionId);
    },
    stampInRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      if (!state.currentRoundId) state.currentRoundId = generateRoundId('assistant');
      return { round_id: state.currentRoundId, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
    },
    stampUserMessage(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      state.nextBlockIndex = 0;
      return { round_id: generateRoundId('user'), message_index: 0, block_index: 0 };
    },
    stampPre(_sessionId: string): RoundStamp {
      return { round_id: generateRoundId('pre'), message_index: 0, block_index: 0 };
    },
    stampCompacted(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      return { round_id: generateRoundId('compacted'), message_index: 0, block_index: 0 };
    },
    stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      const round_id = state.currentRoundId ?? generateRoundId('diagnostic');
      return { round_id, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
    },
    closeRound(sessionId: string): void {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      state.nextBlockIndex = 0;
    },
    recordAppend(): void {},
    getActivityStatus(): { status: 'idle'; pending_calls: []; updated_at: string } { return { status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() }; },
  };
  return runtime;
}

export function createTestAnalystRuntime(opts: { eventBus?: EventBus; cardStore?: CardStore; projectRoot?: string } = {}): AnalystRuntimeDeps {
  const eventBus = opts.eventBus ?? new EventBus();
  const analystRuntime = createFlatTestAnalystRuntime({ ...opts, eventBus });
  const projectRoot = opts.projectRoot ?? mkdtempSync(join(tmpdir(), 'saivage-test-analyst-runtime-'));
  if (!opts.projectRoot) ensureTestSaivageConfig(projectRoot);
  const config = loadConfig(projectRoot).config;
  const availability = new MemoryCandidateAvailability();
  const registry = new ProviderRegistry(config);
  const invocationService = new InvocationService({
    projectRoot,
    saivageDir: join(projectRoot, '.saivage'),
    registry,
    router: new ModelRouter(config, registry, projectRoot, availability),
    candidateAvailability: availability,
  });
  return {
    runtime: analystRuntime,
    cardStore: opts.cardStore ?? new CardStore(projectRoot),
    stamper: analystRuntime,
    candidateAvailability: analystRuntime.candidateAvailability,
    eventLogger: analystRuntime.eventLogger,
    eventBus,
    emitAnalystToolInvoked: (payload) => analystRuntime.emitAnalystToolInvoked(payload),
    provider: createInvocationServiceProvider(invocationService),
    mcpManager: analystRuntime.mcpManager,
  };
}

export function createTestRuntimeApplication(opts: { eventBus?: EventBus; cardStore?: CardStore } = {}): RuntimeApplication {
  const eventBus = opts.eventBus ?? new EventBus();
  const analystRuntime = createFlatTestAnalystRuntime({ ...opts, eventBus });
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-test-runtime-app-'));
  ensureTestSaivageConfig(projectRoot);
  const cardStore = opts.cardStore ?? new CardStore(projectRoot);
  return {
    cardStore,
    runtimeApi: {
      start: () => analystRuntime.start(),
      shutdown: () => analystRuntime.shutdown(),
      pause: () => analystRuntime.pause(),
      resume: () => analystRuntime.resume(),
      startProject: (source) => analystRuntime.startProject(source),
      stopProject: (source) => analystRuntime.stopProject(source),
      subscribe: (options) => analystRuntime.subscribe(options),
      getStatus: () => analystRuntime.getStatus(),
      getActorRuntimeReadModel: () => analystRuntime.getActorRuntimeReadModel(),
      getActivityStatus: (sessionId) => analystRuntime.getActivityStatus(sessionId),
    },
    get analystDeps() {
      const config = loadConfig(projectRoot).config;
      const availability = new MemoryCandidateAvailability();
      const registry = new ProviderRegistry(config);
      const invocationService = new InvocationService({
        projectRoot,
        saivageDir: join(projectRoot, '.saivage'),
        registry,
        router: new ModelRouter(config, registry, projectRoot, availability),
        candidateAvailability: availability,
      });
      return {
        runtime: analystRuntime,
        cardStore,
        stamper: analystRuntime,
        candidateAvailability: analystRuntime.candidateAvailability,
        eventLogger: analystRuntime.eventLogger,
        eventBus,
        emitAnalystToolInvoked: (payload: Parameters<typeof analystRuntime.emitAnalystToolInvoked>[0]) => analystRuntime.emitAnalystToolInvoked(payload),
        provider: createInvocationServiceProvider(invocationService),
        mcpManager: analystRuntime.mcpManager,
      };
    },
    getProviderRoutingReadModel: () => ({ providers: {} }),
    setMcpManager: (mcpManager) => analystRuntime.setMcpManager(mcpManager),
  };
}
