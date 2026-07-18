import type { ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardActivationInput, CardActor, CardCancellationResult, CardProcessorActor } from './card-actor.js';
import { BaseMainLLMCardProcessorActor } from './base-main-llm-card-processor-actor.js';
import type { CompactorPort, LLMProviderPort } from './llm-actor.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import type { RuntimeGate } from '../runtime-gate.js';
import type { CardService } from '../../cards/card-service.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ProcessRunner } from '../process-runner.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { ConversationChangePublisher } from './conversation-publisher.js';
import type { CompiledCardProcess } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import { AgentNodeExecution, type NodeTransition } from './agent-node-execution.js';
import type { StructuralChildRelationship } from './executing-llm-snapshot.js';

type ProcessOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export class CardProcessActor extends BaseMainLLMCardProcessorActor implements CardProcessorActor {
  static _actor: ActorDefinition = { initial: 'idle', states: { idle: { parked: true, on: { activate: 'running' } }, running: { on: { done: 'settled', blocked: 'settled', failed: 'settled' } }, settled: { parked: true, on: { activate: 'running' } } } };
  readonly #runner: AgentNodeExecution;
  constructor(args: { projectRoot: string; cardId: string; process: CompiledCardProcess; processPrompts: ProcessPromptRegistry; store: CardService; children: { get(cardId: string): CardActor | null }; ownerStructuralWait: { begin(relationship: StructuralChildRelationship): StructuralChildRelationship; end(relationship: StructuralChildRelationship): void }; cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>; notifyCard?: import('./agent-node-execution.js').AgentNodeExecutionDeps['notifyCard']; provider: LLMProviderPort; conversations: ConversationFileContext; appLogs: AppLogContext; processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry; runtimeProjectionChanged(): void; gate?: RuntimeGate; mcpManagerProvider?: () => McpToolInvocationPort | undefined; compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort; conversationPublisher?: ConversationChangePublisher }) {
    super(args); this.process = args.process;
    this.#runner = new AgentNodeExecution({ ...args, mcpManagerProvider: args.mcpManagerProvider ?? (() => undefined) }, { createLlm: (id) => this.createMainLlm(id), selectLlm: (llm) => this.selectExecutingLlm(llm), freshInputId: () => this.freshSourceInputId(), toolContext: (llm, outcome) => this.toolInvocationContext(llm, outcome), publishConversationEntry: (entry) => this.conversationPublisher?.entryAppended(entry) });
  }
  readonly process: CompiledCardProcess;
  _on_enter__running(): void { this.runPendingActivation('running', (input, signal) => this.runActivation(input, signal)); }
  private async runActivation(input: CardActivationInput, signal: AbortSignal): Promise<ProcessOutcome> {
    this.#runner.beginActivation();
    const entry = this.process.entries.get(input.entry); if (!entry) throw new Error(`Process '${this.process.family}' has no '${input.entry}' entry.`);
    let transition: NodeTransition = { kind: 'entry', entry: input.entry, definition: entry }; let nodeId = entry.targetNodeId; let ordinal = 0;
    for (;;) { signal.throwIfAborted(); const node = this.process.nodes.get(nodeId); if (!node) throw new Error(`Process '${this.process.family}' targets missing node '${nodeId}'.`); const accepted = await this.#runner.execute({ node, transition, input, signal, nodeOrdinal: ordinal++ }); if (accepted.edge.target.kind === 'terminal') return mapTerminal(accepted.edge.target.port, accepted.summary); transition = { kind: 'edge', sourceNodeId: node.id, result: accepted }; nodeId = accepted.edge.target.nodeId; }
  }
  protected get processorLabel(): string { return 'Card process'; }
  protected activationFailureOutcome(error: string): ProcessOutcome { return { status: 'failed', summary: error, result: { kind: 'failed', summary: error } }; }
}
function mapTerminal(port: 'DONE' | 'BLOCKED' | 'FAILED', summary: string): ProcessOutcome { return port === 'DONE' ? { status: 'done', summary, result: { kind: 'done', summary } } : port === 'BLOCKED' ? { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } } : { status: 'failed', summary, result: { kind: 'failed', summary } }; }
