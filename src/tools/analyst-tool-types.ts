import type { CardService } from '../cards/card-api.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';
import type { ToolActionOutcome } from '../contracts/tool-result.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { InterventionReadinessFacet } from '../application/intervention-readiness.js';
import type { AnalystMutationServices } from '../application/analyst-mutation-services.js';
import type { AnalystPreparationReadServices } from '../application/analyst-prepare/webfetch.js';
import type { EventQueryService } from '../application/event-query-service.js';
import type { CardTypeName, ConversationSessionId } from '../schemas/index.js';
import type { RestartCapability } from '../contracts/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';

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
