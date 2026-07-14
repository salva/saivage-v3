import type { CardStore } from '../cards/store-api.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';
import type { EventBus } from '../events/index.js';
import type { AppLogStore } from '../persistence/app-log.js';
import type { ToolResult } from './invocation.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { InterventionReadinessFacet } from '../application/intervention-readiness.js';
import type { RuntimeControlApplicationPort } from '../application/runtime-control-service.js';

export type { ToolResult };

export type SafeToolDataValue = string | number | boolean | null | readonly SafeToolDataValue[] | { readonly [key: string]: SafeToolDataValue };

export interface SafeToolData {
  readonly [key: string]: SafeToolDataValue;
}

export interface ToolContext {
  projectRoot: string;
  configAuthority: ResolvedConfigAuthority;
  persistenceHealth: ApplicationPersistenceHealth;
  interventionReadiness: InterventionReadinessFacet;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  store: CardStore;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'pause' | 'resume' | 'notifyCard' | 'getStatus'>;
  runtimeControl?: RuntimeControlApplicationPort;
  mcpManager?: McpManager;
  restartServerAvailable: boolean;
  actor: ActorRole;
  surface: ControlActionSurface;
  eventBus?: EventBus;
  appLogs: AppLogStore;
}
