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
} from '../schemas/index.js';
import type { NotificationCenter } from '../notifications/index.js';
import type { LlmCallFn } from './llm-contracts.js';
import { EventLogger } from '../observability/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { getProjectNotificationCenter } from '../notifications/notification-delivery.js';
import type { CardStore } from '../cards/store-api.js';
import { InvocationService } from './invocation-service.js';

export type AgentRole = OperationalAgentRole;
export type InvokableAgentRole = AgentInvocationRole;

export interface AgentAdapterConfig {
  projectRoot: string;
  saivageDir: string;
  config: SaivageConfig;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
  candidateAvailability?: CandidateAvailability;
  cardStore?: CardStore;
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
  readonly eventLogger?: EventLogger;
  private _mcpManager: McpToolInvocationPort | undefined;
  private readonly invocationService: InvocationService;
  private readonly cardStore: CardStore;

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
    if (!cfg.cardStore) throw new Error('AgentAdapter requires a composition-owned CardStore.');
    this.cardStore = cfg.cardStore;
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
  setMcpManager(mcpManager: McpToolInvocationPort): void {
    this._mcpManager = mcpManager;
  }
  getMcpManager(): McpToolInvocationPort | undefined {
    return this._mcpManager;
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
}
