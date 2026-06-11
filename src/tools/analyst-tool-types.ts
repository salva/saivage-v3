import type { CardStore } from '../cards/store-api.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';
import type { EventBus } from '../events/index.js';

export interface ActionPreview {
  type: string;
  summary: string;
  affectedCards: Array<{ id: string; title: string; type: string; status: string }>;
  affectedProcesses: Array<{ id: string; command: string; status: string }>;
  warnings: string[];
}

export type ToolErrorKind =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'io'
  | 'provider'
  | 'internal';

export interface ToolErrorEnvelope {
  kind: ToolErrorKind;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  preview?: ActionPreview;
  error?: string;
  errorEnvelope?: ToolErrorEnvelope;
}

export interface ToolContext {
  projectRoot: string;
  store: CardStore;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume' | 'getStatus'>;
  mcpManager?: McpManager;
  requestServerRestart?: () => Promise<void>;
  actor: ActorRole;
  surface: ControlActionSurface;
  eventBus?: EventBus;
}
