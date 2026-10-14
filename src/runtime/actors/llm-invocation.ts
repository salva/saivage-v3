import type { AgentName, ConversationSessionId } from '../../schemas/index.js';
import type {
  ProviderConversationProjection,
  ToolDefinition,
  CompiledInvocationToolContract,
  PreparedInvocationContext,
  PreparedCompaction,
  InvocationRoutePass,
} from '../../contracts/index.js';
import type { CapabilityRequest } from '../../contracts/index.js';
import type { ContextBlock, ValidatedConversation } from '../../contracts/index.js';
import type { AgentMessage } from '../../schemas/index.js';

/** Transient node-bound synchronous preparation, never provider or durable data. */
export type RecordContextSupplier = (
  args: Readonly<{
    inputId: string;
    conversation: ValidatedConversation;
  }>,
) => Readonly<{
  recordBlocks: readonly ContextBlock[];
  rows: readonly AgentMessage[];
}>;

interface LlmInvocationInputBase {
  inputId: string;
  agentId: string;
  agentName: AgentName;
  /** Invocation/persistence owner. Ordinary actor turns require this to equal providerConversation.sourceSessionId. */
  sessionId: string;
  systemPrompt: string;
  /** Complete ordered request projection: frozen synthetic context plus current provider-eligible canonical rows. */
  providerConversation: ProviderConversationProjection;
  tools: ToolDefinition[];
  compiledToolContracts: readonly CompiledInvocationToolContract[];
  terminalToolNames: string[];
  capabilityRequest: CapabilityRequest;
  episodeContext: Record<string, unknown>;
  routePass: InvocationRoutePass;
}

export type LlmInvocationInput = LlmInvocationInputBase &
  (
    | {
        preparedCompaction: PreparedCompaction;
        preparedContext: PreparedInvocationContext;
        modelParams: { temperature: number; maxTokens?: never };
      }
    | {
        preparedCompaction?: never;
        preparedContext?: never;
        modelParams: { temperature: number; maxTokens: number };
      }
  );

export type CanonicalLlmInvocationInput = LlmInvocationInput & { sessionId: ConversationSessionId };
export type PreparedLlmInvocationInput = Extract<
  CanonicalLlmInvocationInput,
  { preparedCompaction: PreparedCompaction }
>;
