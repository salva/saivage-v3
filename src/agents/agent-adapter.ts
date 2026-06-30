import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { getRuntimeConfig } from './config-schema.js';
import { ProviderRegistry } from './provider.js';
import { ModelRouter } from './model-router.js';
import {
  type CandidateAvailability,
  MemoryCandidateAvailability,
} from './candidate-availability.js';
import type {
  AgentInvocationRole,
  OperationalAgentRole,
  RuntimeState,
} from '../schemas/index.js';
import type { TypedEventEmitter } from '../events/index.js';
import type { NotificationCenter } from '../notifications/index.js';
import type { ContentSupervisor } from '../workspace/index.js';
import { getSafeFileForAgent, type SafeFileResult } from '../workspace/index.js';
import type { RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { LlmCallFn } from './llm-contracts.js';
import { EventLogger } from '../observability/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { SkillsEngine } from './skills-engine.js';
import { getProjectNotificationCenter } from '../notifications/notification-delivery.js';
import type { CardStore } from '../cards/store-api.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { createPlannerControlExecutor } from './planner-control-factory.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import { AgentToolExecutor } from './agent-tool-executor.js';
import { InvocationService } from './invocation-service.js';
import { SessionInvariantError } from './session-invariant-error.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;

export { SessionInvariantError } from './session-invariant-error.js';

export interface AgentAdapterConfig {
  projectRoot: string;
  saivageDir: string;
  config: SaivageConfig;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
  activationLedger?: RuntimeActivationLedgerPort;
  candidateAvailability?: CandidateAvailability;
  cardStore?: CardStore;
  runtimeStateProvider?: () => RuntimeState | null;
  invocationService?: InvocationService;
  llmCallFn?: LlmCallFn;
}

export class AgentAdapter {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly candidateAvailability: CandidateAvailability;
  readonly notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  private runtimeLedgerEventBus?: TypedEventEmitter;
  readonly eventLogger?: EventLogger;
  private contentSupervisor?: ContentSupervisor;
  private _mcpManager: McpToolInvocationPort | undefined;
  private _skillsEngine: SkillsEngine | undefined;
  private activationLedger?: RuntimeActivationLedgerPort;
  private readonly plannerControlExecutor: PlannerControlExecutor;
  private readonly toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly invocationService: InvocationService;
  private readonly cardStore: CardStore;
  private readonly runtimeStateProvider?: () => RuntimeState | null;

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.candidateAvailability = cfg.candidateAvailability ?? new MemoryCandidateAvailability();
    this.router = new ModelRouter(
      cfg.config,
      this.registry,
      cfg.projectRoot,
      this.candidateAvailability,
    );
    this.notificationCenter = getProjectNotificationCenter(cfg.projectRoot);
    this.eventBus = cfg.eventBus;
    this.eventLogger = cfg.eventLogger;
    this.activationLedger = cfg.activationLedger;
    if (!cfg.cardStore) throw new Error('AgentAdapter requires a composition-owned CardStore.');
    this.cardStore = cfg.cardStore;
    this.runtimeStateProvider = cfg.runtimeStateProvider;
    this.toolRuntime = new ToolRuntime(
      { cardStore: this.cardStore, bus: cfg.eventBus },
      AGENT_TOOL_DEFINITIONS,
    );
    this.plannerControlExecutor = createPlannerControlExecutor({
      cardStore: this.cardStore,
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      runtimeStateProvider: () => this.activationLedger?.readState() ?? null,
      activationLedgerProvider: () => this.activationLedger,
      eventBusProvider: () => this.runtimeLedgerEventBus,
      eventLogger: this.eventLogger,
    });
    this.toolExecutor = new AgentToolExecutor({
      projectRoot: this.projectRoot,
      toolRuntime: this.toolRuntime,
      plannerControlExecutor: this.plannerControlExecutor,
      getMcpManager: () => this._mcpManager,
      getSkillsEngine: () => this._skillsEngine,
      getContentSupervisor: () => this.contentSupervisor,
    });
    this.invocationService = cfg.invocationService ?? new InvocationService({
      projectRoot: this.projectRoot,
      saivageDir: this.saivageDir,
      registry: this.registry,
      router: this.router,
      eventLogger: this.eventLogger,
      candidateAvailability: this.candidateAvailability,
      recoveryDelayMs: this.runtimeConfig?.recoveryDelayMs,
      maxRecoveryRetries: this.runtimeConfig?.maxRecoveryRetries,
      llmCallFn: cfg.llmCallFn,
    });
  }

  setEventBus(eventBus: EventEmitter): void {
    this.eventBus = eventBus;
  }
  setRuntimeLedgerEventBus(eventBus: TypedEventEmitter): void {
    this.runtimeLedgerEventBus = eventBus;
  }
  setActivationLedger(activationLedger: RuntimeActivationLedgerPort): void {
    this.activationLedger = activationLedger;
  }
  setContentSupervisor(supervisor: ContentSupervisor): void {
    this.contentSupervisor = supervisor;
  }
  getContentSupervisor(): ContentSupervisor | undefined {
    return this.contentSupervisor;
  }
  setMcpManager(mcpManager: McpToolInvocationPort): void {
    this._mcpManager = mcpManager;
  }
  getMcpManager(): McpToolInvocationPort | undefined {
    return this._mcpManager;
  }
  setSkillsEngine(engine: SkillsEngine): void {
    this._skillsEngine = engine;
  }
  getSkillsEngine(): SkillsEngine | undefined {
    return this._skillsEngine;
  }

  public getToolNamesForRole(role: AgentRole): string[] {
    return this.toolExecutor.getToolNamesForRole(role);
  }
  async callMcpTool(
    role: AgentRole,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.toolExecutor.callMcpTool(role, serverName, toolName, args);
  }

  getSafeFileContent(filePath: string, content: string): SafeFileResult {
    return getSafeFileForAgent(filePath, content);
  }
  private redactModelIssue(message: unknown): string {
    return redactTextForOutbound(message, 'model.issue', { source: 'agent-adapter' });
  }

  getRouter(): ModelRouter {
    return this.router;
  }
  getRegistry(): ProviderRegistry {
    return this.registry;
  }
  getCandidateAvailability(): CandidateAvailability {
    return this.candidateAvailability;
  }
  getInvocationService(): InvocationService {
    return this.invocationService;
  }

  async flushRecorders(): Promise<void> {
    await this.invocationService.flushRecorders();
  }
}
