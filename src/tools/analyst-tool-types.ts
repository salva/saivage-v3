import type { CardService } from '../cards/card-api.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';
import type { EventBus } from '../events/index.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { ToolResult } from './invocation.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { InterventionReadinessFacet } from '../application/intervention-readiness.js';
import type { RuntimeControlApplicationPort } from '../application/runtime-control-service.js';
import type { AnalystMutationServices } from '../application/analyst-mutation-services.js';
import type { AnalystPreparationReadServices } from '../application/analyst-prepare/webfetch.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';

export type { ToolResult };

export type SafeToolDataValue = string | number | boolean | null | readonly SafeToolDataValue[] | { readonly [key: string]: SafeToolDataValue };

export interface SafeToolData {
  readonly [key: string]: SafeToolDataValue;
}

export interface ToolContext {
  projectRoot: string;
  configAuthority: ResolvedConfigAuthority;
  interventionReadiness: InterventionReadinessFacet;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  store: CardService;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'pause' | 'resume' | 'notifyCard' | 'getStatus'>;
  runtimeControl?: RuntimeControlApplicationPort;
  mcpToolInvocation: McpToolInvocationPort;
  restartServerAvailable: boolean;
  actor: ActorRole;
  surface: ControlActionSurface;
  eventBus?: EventBus;
  appLogs: AppLogContext;
  analystMutations?: AnalystMutationServices;
  analystPreparation?: AnalystPreparationReadServices;
  captureExecutingLlmSnapshots(): readonly ExecutingLlmSnapshot[];
}
