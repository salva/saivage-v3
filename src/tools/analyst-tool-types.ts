import type { CardStore } from '../cards/store-api.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';
import type { EventBus } from '../events/index.js';
import type { ToolResult } from './invocation.js';

export type { ToolResult };

export type ToolErrorKind =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'io'
  | 'provider'
  | 'internal';

export interface ToolContext {
  projectRoot: string;
  store: CardStore;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume' | 'notifyCard' | 'getStatus'>;
  mcpManager?: McpManager;
  requestServerRestart?: () => Promise<void>;
  actor: ActorRole;
  surface: ControlActionSurface;
  eventBus?: EventBus;
}
