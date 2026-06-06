import type { CardStore } from '../cards/store-api.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ActorRole } from '../agents/authz.js';

export interface ActionPreview {
  type: string;
  summary: string;
  affectedCards: Array<{ id: string; title: string; type: string; status: string }>;
  affectedProcesses: Array<{ id: string; command: string; status: string }>;
  warnings: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  preview?: ActionPreview;
  error?: string;
}

export interface ToolContext {
  projectRoot: string;
  store: CardStore;
  sessionId?: string;
  runtime?: Pick<RuntimeApi, 'startProject' | 'stopProject' | 'pause' | 'resume'>;
  mcpManager?: McpManager;
  requestServerRestart?: () => Promise<void>;
  actor: ActorRole;
  surface: ControlActionSurface;
}
