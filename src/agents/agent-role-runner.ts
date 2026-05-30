import type { EventEmitter } from 'node:events';
import type { SaivageConfig } from './config-schema.js';
import type { EventLogger } from '../observability/index.js';
import type { AgentRole } from './agent-adapter.js';

export interface AgentRoleRunnerConfig {
  config: SaivageConfig;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
}

export class AgentRoleRunner {
  private readonly config: SaivageConfig;
  private eventBus?: EventEmitter;
  private readonly eventLogger?: EventLogger;
  private lastRole: string | null = null;

  constructor(config: AgentRoleRunnerConfig) {
    this.config = config.config;
    this.eventBus = config.eventBus;
    this.eventLogger = config.eventLogger;
  }

  setEventBus(eventBus: EventEmitter): void { this.eventBus = eventBus; }

  resetOnRoleChange(role: AgentRole): void {
    this.lastRole = role;
  }
}

