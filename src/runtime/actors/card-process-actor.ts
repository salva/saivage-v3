import { randomUUID } from 'node:crypto';
import { BaseActor, type ActorDefinition } from '../micro-actor/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardActivationInput, CardActor, CardCancellationResult, CardProcessorActor } from './card-actor.js';
import { ConversationLLMActor, type CompactorPort, type LLMActorOutcome, type LLMProviderPort } from './llm-actor.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import { RuntimeGate } from '../runtime-gate.js';
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
import type { ExecutingLlmSnapshot, LlmToolInvocationContext, StructuralChildRelationship } from './executing-llm-snapshot.js';
import { deferred, type Deferred } from './deferred.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from './invocation-lifecycle.js';
import { isRuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import { parseLlmActorId } from './ids.js';
import { parseConversationSessionId } from '../../schemas/index.js';

type ProcessOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export class CardProcessActor extends BaseActor implements CardProcessorActor {
  static _actor: ActorDefinition = { initial: 'idle', states: { idle: { parked: true, on: { activate: 'running' } }, running: { on: { done: 'settled', blocked: 'settled', failed: 'settled' } }, settled: { parked: true, on: { activate: 'running' } } } };
  readonly projectRoot: string;
  readonly cardId: string;
  readonly process: CompiledCardProcess;
  readonly #provider: LLMProviderPort;
  readonly #conversations: ConversationFileContext;
  readonly #gate: RuntimeGate;
  readonly #compactor: CompactorPort;
  readonly #summarizerProvider: SummarizerProviderPort;
  readonly #conversationPublisher?: ConversationChangePublisher;
  readonly #runtimeProjectionChanged: () => void;
  readonly #activeLlmActors = new Map<string, ConversationLLMActor>();
  readonly #runner: AgentNodeExecution;
  #result: Deferred<ProcessOutcome> | null = null;
  #activationInput: CardActivationInput | null = null;
  #activationSignal: AbortSignal | null = null;
  #operationTracker: ActivationOperationTracker | null = null;
  #joiningLlmActors: readonly ConversationLLMActor[] | null = null;
  #llmInvocationsDisposed = false;
  #currentExecutingLlm: ConversationLLMActor | null = null;

  constructor(args: { projectRoot: string; cardId: string; process: CompiledCardProcess; processPrompts: ProcessPromptRegistry; store: CardService; children: { get(cardId: string): CardActor | null }; ownerStructuralWait: { begin(relationship: StructuralChildRelationship): StructuralChildRelationship; end(relationship: StructuralChildRelationship): void }; cancelCard(cardId: string, reason: string): Promise<CardCancellationResult>; notifyCard?: import('./agent-node-execution.js').AgentNodeExecutionDeps['notifyCard']; provider: LLMProviderPort; conversations: ConversationFileContext; appLogs: AppLogContext; processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry; runtimeProjectionChanged(): void; gate?: RuntimeGate; mcpManagerProvider?: () => McpToolInvocationPort | undefined; compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort; conversationPublisher?: ConversationChangePublisher }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.process = args.process;
    this.#provider = args.provider;
    this.#conversations = args.conversations;
    this.#gate = args.gate ?? new RuntimeGate();
    this.#compactor = args.compactor;
    this.#summarizerProvider = args.summarizerProvider;
    this.#conversationPublisher = args.conversationPublisher;
    this.#runtimeProjectionChanged = args.runtimeProjectionChanged;
    this.#runner = new AgentNodeExecution({
      projectRoot: args.projectRoot,
      cardId: args.cardId,
      store: args.store,
      children: args.children,
      ownerStructuralWait: args.ownerStructuralWait,
      cancelCard: args.cancelCard,
      notifyCard: args.notifyCard,
      appLogs: args.appLogs,
      processRunner: args.processRunner,
      mcpManagerProvider: args.mcpManagerProvider ?? (() => undefined),
      promptTemplates: args.promptTemplates,
      processPrompts: args.processPrompts,
      conversations: args.conversations,
      compactionConfig: args.compactionConfig,
    }, {
      createLlm: (id) => this.#createMainLlm(id),
      selectLlm: (llm) => this.#selectExecutingLlm(llm),
      freshInputId: () => this.#freshSourceInputId(),
      toolContext: (llm, outcome) => this.#toolInvocationContext(llm, outcome),
      publishConversationEntry: (entry) => this.#conversationPublisher?.entryAppended(entry),
    });
  }

  activate(input: CardActivationInput, signal: AbortSignal): Promise<ProcessOutcome> {
    if (this.#result && this.#isActiveState(this.state())) return this.#result.promise;
    if (this.#result) return Promise.reject(new Error(`Card process '${this.cardId}' already has a pending activation.`));
    if (!this.#canActivateFrom(this.state())) return Promise.reject(new Error(`Card process '${this.cardId}' cannot activate from '${this.state()}'.`));
    this.#activationInput = input;
    this.#activationSignal = signal;
    this.#operationTracker = new ActivationOperationTracker();
    this.#result = deferred<ProcessOutcome>();
    this.parkedSendEvent('activate');
    return this.#result.promise;
  }

  disposeActivation(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.#activeLlmActors.values()];
    if (!this.#llmInvocationsDisposed) {
      for (const llm of this.#joiningLlmActors) llm.disposeInvocations(reason);
      this.#llmInvocationsDisposed = true;
    }
    this.#operationTracker?.revoke(reason);
  }

  suppressContinuationAndPrepareJoin(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.#activeLlmActors.values()];
    for (const llm of this.#joiningLlmActors) llm.closeInvocationAdmission(reason);
    this.#operationTracker?.closeAdmission(reason);
  }

  async joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const actors = this.#joiningLlmActors;
    if (!actors) throw new Error(`Processor '${this.cardId}' must dispose activation admission before join.`);
    const outcomes = await Promise.all(actors.map((llm) => llm.joinInvocationSettlement()));
    const processorOutcomes = await this.#joinProcessorActivation();
    const hadActors = this.#activeLlmActors.size > 0;
    this.#activeLlmActors.clear();
    if (hadActors) this.#runtimeProjectionChanged();
    return [...outcomes, ...processorOutcomes];
  }

  pendingJoinTaskCount(): number {
    return (this.#operationTracker?.pendingCount() ?? 0) + (this.#joiningLlmActors ?? []).reduce((count, llm) => count + llm.pendingInvocationCount(), 0);
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    if (this.#result === null || this.state() !== 'running') return null;
    const llm = this.#currentExecutingLlm;
    if (!llm) return null;
    const identity = parseLlmActorId(llm.agentId);
    if (identity.cardId !== this.cardId || identity.role === 'analyst') throw new Error(`Current LLM actor '${llm.agentId}' does not belong to processor '${this.cardId}'.`);
    return Object.freeze({ sessionId: parseConversationSessionId(llm.agentId), agentId: llm.agentId, role: identity.role, cardId: identity.cardId, activity: llm.executingActivity() });
  }

  _on_enter__running(): void {
    if (!this.#result || !this.#activationInput || !this.#activationSignal) throw new Error(`Card process '${this.cardId}' entered running without activation input.`);
    const input = this.#activationInput;
    const signal = this.#activationSignal;
    const tracker = this.#operationTracker;
    if (!tracker) throw new Error(`Card process '${this.cardId}' has no activation operation tracker.`);
    this.runTask((taskSignal) => tracker.run(AbortSignal.any([signal, taskSignal]), (operationSignal) => this.#runActivation(input, operationSignal)), {
      on_done: (outcome) => { void tracker.trackConsumer(() => this.#finishActivation(outcome)); },
      on_failed: (error) => { void tracker.trackConsumer(() => {
        if (isRuntimeStoppedInterruption(error)) { this.#failActivation(error); return; }
        this.#finishActivation({ status: 'failed', summary: error.message, result: { kind: 'failed', summary: error.message } });
      }); },
    });
  }

  async #runActivation(input: CardActivationInput, signal: AbortSignal): Promise<ProcessOutcome> {
    this.#runner.beginActivation();
    const entry = this.process.entries.get(input.entry); if (!entry) throw new Error(`Process '${this.process.family}' has no '${input.entry}' entry.`);
    let transition: NodeTransition = { kind: 'entry', entry: input.entry, definition: entry }; let nodeId = entry.targetNodeId; let ordinal = 0;
    for (;;) { signal.throwIfAborted(); const node = this.process.nodes.get(nodeId); if (!node) throw new Error(`Process '${this.process.family}' targets missing node '${nodeId}'.`); const accepted = await this.#runner.execute({ node, transition, input, signal, nodeOrdinal: ordinal++ }); if (accepted.edge.target.kind === 'terminal') return mapTerminal(accepted.edge.target.port, accepted.summary); transition = { kind: 'edge', sourceNodeId: node.id, result: accepted }; nodeId = accepted.edge.target.nodeId; }
  }

  #createMainLlm(agentId: string): ConversationLLMActor {
    const existing = this.#activeLlmActors.get(agentId);
    if (existing) return existing;
    const llm = new ConversationLLMActor({ projectRoot: this.projectRoot, agentId, provider: this.#provider, conversations: this.#conversations, gate: this.#gate, compactor: this.#compactor, summarizerProvider: this.#summarizerProvider, conversationPublisher: this.#conversationPublisher, runtimeProjectionChanged: this.#runtimeProjectionChanged });
    llm.start();
    this.#activeLlmActors.set(agentId, llm);
    this.#runtimeProjectionChanged();
    return llm;
  }

  #selectExecutingLlm(llm: ConversationLLMActor): void {
    const current = this.#currentExecutingLlm;
    if (!current) {
      this.#currentExecutingLlm = llm;
      llm.resetExecutingActivity();
      this.#runtimeProjectionChanged();
      return;
    }
    if (current === llm) return;
    if (current.executingActivity().mode !== 'active') throw new Error(`Processor '${this.cardId}' cannot hand off an LLM actor while waiting.`);
    this.#currentExecutingLlm = llm;
    llm.resetExecutingActivity();
    this.#runtimeProjectionChanged();
  }

  #toolInvocationContext(llm: ConversationLLMActor, outcome: Extract<LLMActorOutcome, { type: 'tool_call' }>): LlmToolInvocationContext {
    if (this.#currentExecutingLlm !== llm || outcome.agentId !== llm.agentId) throw new Error(`Tool call '${outcome.toolCallId}' does not belong to the current LLM actor.`);
    const identity = { sessionId: parseConversationSessionId(llm.agentId), sourceInputId: outcome.inputId, toolCallId: outcome.toolCallId, toolName: outcome.toolName };
    return { ...identity, waits: llm.waitCallbacks(identity) };
  }

  #freshSourceInputId(): string { return randomUUID(); }

  #finishActivation(outcome: ProcessOutcome): void {
    if (this.#currentExecutingLlm?.executingActivity().mode === 'waiting') throw new Error(`Processor '${this.cardId}' settled while its current LLM actor was waiting.`);
    this.#currentExecutingLlm = null;
    this.#runtimeProjectionChanged();
    if (!this.#joiningLlmActors) {
      for (const llm of this.#activeLlmActors.values()) llm.abandonParkedTurn();
      const hadActors = this.#activeLlmActors.size > 0;
      this.#activeLlmActors.clear();
      if (hadActors) this.#runtimeProjectionChanged();
    }
    this.#result?.resolve(outcome);
    this.#result = null;
    this.#activationInput = null;
    this.#activationSignal = null;
    this.sendEvent(outcome.status);
  }

  #failActivation(error: Error): void {
    if (this.#currentExecutingLlm?.executingActivity().mode === 'waiting') throw new Error(`Processor '${this.cardId}' failed while its current LLM actor was waiting.`);
    this.#currentExecutingLlm = null;
    this.#runtimeProjectionChanged();
    this.#result?.reject(error);
    this.#result = null;
    this.#activationInput = null;
    this.#activationSignal = null;
    this.sendEvent('failed');
  }

  async #joinProcessorActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const tracker = this.#operationTracker;
    if (!tracker) {
      await this.awaitLifecycleSettlement();
      return [];
    }
    const outcome = await tracker.join();
    await this.awaitLifecycleSettlement();
    return [outcome];
  }

  #canActivateFrom(state: string): boolean { return state === 'idle' || state === 'settled'; }
  #isActiveState(state: string): boolean { return state !== 'idle' && state !== 'settled'; }
}
function mapTerminal(port: 'DONE' | 'BLOCKED' | 'FAILED', summary: string): ProcessOutcome { return port === 'DONE' ? { status: 'done', summary, result: { kind: 'done', summary } } : port === 'BLOCKED' ? { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } } : { status: 'failed', summary, result: { kind: 'failed', summary } }; }
