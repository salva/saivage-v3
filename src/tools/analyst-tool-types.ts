import type { CardStore } from '../cards/store-api.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';
import type { EventBus } from '../events/index.js';
import type { ToolResult } from './invocation.js';
import type { ProcessRunner } from '../runtime/process-runner.js';

export type { ToolResult };

export type SafeToolDataValue = string | number | boolean | null | readonly SafeToolDataValue[] | { readonly [key: string]: SafeToolDataValue };

export interface SafeToolData {
  readonly [key: string]: SafeToolDataValue;
}

export interface ToolContext {
  projectRoot: string;
  processRunner: ProcessRunner;
  store: CardStore;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'pause' | 'resume' | 'notifyCard' | 'getStatus'>;
  mcpManager?: McpManager;
  restartServerAvailable: boolean;
  actor: ActorRole;
  surface: ControlActionSurface;
  eventBus?: EventBus;
}
