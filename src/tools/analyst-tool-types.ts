import type { CardService } from '../cards/store-api.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';
import type { ToolActionOutcome, RestartCapability } from '../contracts/index.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/runtime-api.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { InterventionReadinessFacet } from '../contracts/index.js';
import type { AnalystMutationServices, AnalystPreparationReadServices, EventQueryService } from '../application/index.js';
import type { CardTypeName, ConversationSessionId } from '../schemas/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/runtime-api.js';

export type AnalystToolOutcome = ToolActionOutcome;

type SafeToolDataValue =
  | string
  | number
  | boolean
  | null
  | readonly SafeToolDataValue[]
  | { readonly [key: string]: SafeToolDataValue };

export interface SafeToolData {
  readonly [key: string]: SafeToolDataValue;
}

export interface ToolContext {
  cardTypeVocabulary: readonly CardTypeName[];
  projectRoot: string;
  configAuthority: ResolvedConfigAuthority;
  interventionReadiness: InterventionReadinessFacet;
  processRunner: ProcessRunner;
  processScope: ManagedProcessScope;
  store: CardService;
  sessionId?: string;
  runtime: Pick<
    RuntimeApi,
    'startProject' | 'pause' | 'resume' | 'stopProject' | 'notifyCard' | 'getStatus'
  >;
  mcpToolInvocation: McpToolInvocationPort;
  restartCapability: RestartCapability;
  actor: import('../schemas/index.js').AgentName;
  surface: 'web-chat';
  analystMutations?: AnalystMutationServices;
  analystPreparation?: AnalystPreparationReadServices;
  eventQueries: EventQueryService;
  captureExecutingLlmSnapshots: () => ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot>;
}
