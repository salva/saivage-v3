import type { EventEmitter } from 'node:events';
import type { SaivageConfig } from './config-schema.js';
import { getSelfCheckThreshold } from './config-schema.js';
import { buildSelfCheckPrompt } from './system-prompt.js';
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
  private readonly roundCounters: Map<string, number> = new Map();
  private lastRole: string | null = null;

  constructor(config: AgentRoleRunnerConfig) {
    this.config = config.config;
    this.eventBus = config.eventBus;
    this.eventLogger = config.eventLogger;
  }

  setEventBus(eventBus: EventEmitter): void { this.eventBus = eventBus; }

  resetOnRoleChange(role: AgentRole): void {
    if (this.lastRole !== null && this.lastRole !== role) this.roundCounters.clear();
    this.lastRole = role;
  }

  applySelfCheck(role: AgentRole, systemPrompt: string, sessionId: string): string {
    const key = role;
    const current = (this.roundCounters.get(key) ?? 0) + 1;
    this.roundCounters.set(key, current);
    const threshold = getSelfCheckThreshold(this.config, role);
    if (threshold <= 0 || current % threshold !== 0) return systemPrompt;
    const selfCheckPrompt = buildSelfCheckPrompt(role, current, threshold);
    const modifiedPrompt = systemPrompt + '\n\n' + selfCheckPrompt;
    this.eventLogger?.appendEvent({ kind: 'self_check_triggered', session_id: sessionId, role: role as unknown as import('../schemas/types.js').AgentRole, rounds: current, threshold });
    this.eventBus?.emit('self_check_triggered', { session_id: sessionId, role, rounds: current, threshold });
    return modifiedPrompt;
  }
}
