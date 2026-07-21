import { randomUUID } from 'node:crypto';
import { BaseActor, type ActorLifecycleContext, type ActorTransitionContext } from '../micro-actor/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardActivationInput, CardProcessorActor, PlannerChildControlPort } from './card-activation-owner.js';
import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from './llm-actor.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';
import { RuntimeGate } from '../runtime-gate.js';
import type { CardService } from '../../cards/card-service.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ProcessRunner } from '../process-runner.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import type { SummarizerProviderPort } from './compaction/summarizer.js';
import type { CompiledCardProcess, ProcessPosition } from '../card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import { AgentNodeExecution, type AcceptedNodeResult, type NodeTransition } from './agent-node-execution.js';
import type { ExecutingLlmSnapshot } from './executing-llm-snapshot.js';
import { deferred, type Deferred } from './deferred.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from './invocation-lifecycle.js';
import { isRuntimeStoppedInterruption } from './runtime-stopped-interruption.js';
import { parseLlmActorId } from './ids.js';
import { parseConversationSessionId } from '../../schemas/index.js';

type ProcessOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export class CardProcessActor extends BaseActor implements CardProcessorActor {
  readonly projectRoot: string;
  readonly cardId: string;
  readonly process: CompiledCardProcess;
  readonly #provider: LLMProviderPort;
  readonly #conversations: ConversationFileContext;
  readonly #gate: RuntimeGate;
  readonly #compactor: CompactorPort;
  readonly #summarizerProvider: SummarizerProviderPort;
  readonly #runtimeProjectionChanged: () => void;
  readonly #activeLlmActors = new Map<string, ConversationLLMActor>();
  readonly #runner: AgentNodeExecution;
  #result: Deferred<ProcessOutcome> | null = null;
  #activationInput: CardActivationInput | null = null;
  #activationSignal: AbortSignal | null = null;
  #operationTracker: ActivationOperationTracker | null = null;
  #joiningLlmActors: readonly ConversationLLMActor[] | null = null;
  #activationJoin: Promise<readonly InvocationJoinOutcome[]> | null = null;
  #llmInvocationsDisposed = false;
  #currentExecutingLlm: ConversationLLMActor | null = null;
  #executionOrdinal: number | null = null;
  #stagedResult: AcceptedNodeResult | null = null;
  #stagedFailure: Error | null = null;
  #activationSettled = false;

  constructor(args: { projectRoot: string; cardId: string; process: CompiledCardProcess; processPrompts: ProcessPromptRegistry; store: CardService; parentControl: PlannerChildControlPort; notifyCard: import('./agent-node-execution.js').AgentNodeExecutionDeps['notifyCard']; provider: LLMProviderPort; conversations: ConversationFileContext; processRunner: ProcessRunner; promptTemplates: PromptTemplateRegistry; runtimeProjectionChanged(): void; gate?: RuntimeGate; mcpToolInvocation: McpToolInvocationPort; compactor: CompactorPort; compactionConfig: AutonomousCompactionPolicy; summarizerProvider: SummarizerProviderPort }) {
    super(args.process.definition, {
      enter: (context) => this.#enterProcessState(context),
      transition: (context) => this.#processTransitioned(context),
    });
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.process = args.process;
    this.#provider = args.provider;
    this.#conversations = args.conversations;
    this.#gate = args.gate ?? new RuntimeGate();
    this.#compactor = args.compactor;
    this.#summarizerProvider = args.summarizerProvider;
    this.#runtimeProjectionChanged = args.runtimeProjectionChanged;
    this.#runner = new AgentNodeExecution({ projectRoot: args.projectRoot, cardId: args.cardId, store: args.store, parentControl: args.parentControl, notifyCard: args.notifyCard, processRunner: args.processRunner, mcpToolInvocation: args.mcpToolInvocation, promptTemplates: args.promptTemplates, processPrompts: args.processPrompts, conversations: args.conversations, compactionConfig: args.compactionConfig }, {
      createLlm: (id) => this.#createMainLlm(id), selectLlm: (llm) => this.#selectExecutingLlm(llm), freshInputId: () => this.#freshSourceInputId(), assertCurrentActivation: (input) => this.#assertCurrentActivation(input),
    });
  }

  activate(input: CardActivationInput, signal: AbortSignal): Promise<ProcessOutcome> {
    if (this.#result && !this.#activationSettled) return this.#result.promise;
    if (this.#result) return Promise.reject(new Error(`Card process '${this.cardId}' has already completed its activation.`));
    if (this.state() !== 'lifecycle:ready') return Promise.reject(new Error(`Card process '${this.cardId}' cannot activate from '${this.state()}'.`));
    this.#activationInput = input;
    this.#activationSignal = signal;
    this.#executionOrdinal = null;
    this.#activationSettled = false;
    this.#operationTracker = new ActivationOperationTracker();
    this.#runner.beginActivation();
    this.#result = deferred<ProcessOutcome>();
    this.parkedSendEvent(`activate:${input.entry}`);
    return this.#result.promise;
  }

  disposeActivation(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.#activeLlmActors.values()];
    if (!this.#llmInvocationsDisposed) { for (const llm of this.#joiningLlmActors) llm.dispose(reason); this.#llmInvocationsDisposed = true; }
    this.#operationTracker?.revoke(reason);
  }

  suppressContinuationAndPrepareJoin(reason: unknown): void {
    this.#joiningLlmActors ??= [...this.#activeLlmActors.values()];
    for (const llm of this.#joiningLlmActors) llm.suppressContinuation(reason);
    this.#operationTracker?.closeAdmission(reason);
  }

  joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const actors = this.#joiningLlmActors;
    if (!actors) throw new Error(`Processor '${this.cardId}' must dispose activation admission before join.`);
    this.#activationJoin ??= this.#performActivationJoin(actors);
    return this.#activationJoin;
  }

  async #performActivationJoin(actors: readonly ConversationLLMActor[]): Promise<readonly InvocationJoinOutcome[]> {
    const actorJoins = actors.map((llm) => llm.join());
    const processorJoin = this.#joinProcessorActivation();
    const settled = await Promise.allSettled([...actorJoins, processorJoin]);
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failure) throw failure.reason;
    const outcomes = settled.slice(0, actorJoins.length).map((entry) => (entry as PromiseFulfilledResult<InvocationJoinOutcome>).value);
    const processorOutcomes = (settled[settled.length - 1] as PromiseFulfilledResult<readonly InvocationJoinOutcome[]>).value;
    const hadActors = this.#activeLlmActors.size > 0;
    this.#activeLlmActors.clear();
    if (hadActors) this.#runtimeProjectionChanged();
    return [...outcomes, ...processorOutcomes];
  }

  pendingJoinTaskCount(): number { return (this.#operationTracker?.pendingCount() ?? 0) + (this.#joiningLlmActors ?? []).reduce((count, llm) => count + llm.pendingInvocationCount(), 0); }

  processPosition(): ProcessPosition {
    const stateId = this.state();
    const metadata = this.process.states.get(stateId);
    if (!metadata) throw new Error(`Process '${this.process.family}' has no metadata for current state '${stateId}'.`);
    if (metadata.kind === 'ready') return Object.freeze({ family: this.process.family, stateId, kind: 'ready' });
    if (metadata.kind === 'entry') return Object.freeze({ family: this.process.family, stateId, kind: 'entry', entry: metadata.entry });
    if (metadata.kind === 'terminal') return Object.freeze({ family: this.process.family, stateId, kind: 'terminal', terminal: metadata.terminal });
    if (this.#executionOrdinal === null) throw new Error(`Process node '${stateId}' has no execution ordinal.`);
    return Object.freeze({ family: this.process.family, stateId, kind: 'node', nodeId: metadata.nodeId, executionOrdinal: this.#executionOrdinal });
  }

  executingLlmSnapshot(): ExecutingLlmSnapshot | null {
    if (!this.#result || this.process.states.get(this.state())?.kind !== 'node') return null;
    const llm = this.#currentExecutingLlm;
    if (!llm) return null;
    const identity = parseLlmActorId(llm.agentId);
    if (identity.cardId !== this.cardId || identity.role === 'analyst') throw new Error(`Current LLM actor '${llm.agentId}' does not belong to processor '${this.cardId}'.`);
    return Object.freeze({ sessionId: parseConversationSessionId(llm.agentId), agentId: llm.agentId, role: identity.role, cardId: identity.cardId, activity: llm.executingActivity() });
  }

  #enterProcessState(context: ActorLifecycleContext): void {
    const metadata = this.process.states.get(context.target);
    if (!metadata) throw new Error(`Process '${this.process.family}' entered unknown state '${context.target}'.`);
    if (metadata.kind === 'ready') return;
    if (!this.#result || !this.#activationInput || !this.#activationSignal || !this.#operationTracker) throw new Error(`Card process '${this.cardId}' entered '${context.target}' without an activation.`);
    if (metadata.kind === 'entry') {
      if (this.#activationInput.entry !== metadata.entry) throw new Error(`Card process '${this.cardId}' activation entry disagrees with state '${context.target}'.`);
      this.sendEvent('entry:route');
      return;
    }
    if (metadata.kind === 'terminal') { this.#settleTerminal(metadata.terminal, context); return; }
    if (context.source === null || this.#executionOrdinal === null) throw new Error(`Process node '${context.target}' requires an external transition and ordinal.`);
    const transition: NodeTransition = Object.freeze({ context, acceptedResult: this.#stagedResult });
    this.#stagedResult = null;
    const input = this.#activationInput;
    const activationSignal = this.#activationSignal;
    const tracker = this.#operationTracker;
    const ordinal = this.#executionOrdinal;
    this.runTask((stateSignal) => tracker.run(AbortSignal.any([activationSignal, stateSignal]), (operationSignal) => this.#runner.execute({ process: this.process, stateId: context.target, node: metadata, transition, input, signal: operationSignal, nodeOrdinal: ordinal })), {
      on_done: (accepted) => { void tracker.trackConsumer(() => this.#acceptNodeResult(context.target, accepted)); },
      on_failed: (error) => { void tracker.trackConsumer(() => this.#acceptNodeFailure(error)); },
    });
  }

  #processTransitioned(context: ActorTransitionContext): void {
    const source = this.process.states.get(context.source);
    const target = this.process.states.get(context.target);
    if (!source || !target) throw new Error(`Process transition '${context.source}' -> '${context.target}' has missing metadata.`);
    if (source.kind === 'entry' && target.kind === 'node') this.#executionOrdinal = 0;
    else if (source.kind === 'node' && target.kind === 'node') {
      if (!context.event.startsWith('result:') || this.#executionOrdinal === null) throw new Error(`Process node transition '${context.event}' cannot reserve an ordinal.`);
      this.#executionOrdinal += 1;
    }
    this.#runtimeProjectionChanged();
  }

  #acceptNodeResult(sourceState: string, accepted: AcceptedNodeResult): void {
    if (this.state() !== sourceState) throw new Error(`Node result for '${sourceState}' arrived in '${this.state()}'.`);
    const event = `result:${accepted.outcome}`;
    if (!this.process.definition.states.get(sourceState)?.on.has(event)) throw new Error(`Node '${sourceState}' returned unconfigured outcome '${accepted.outcome}'.`);
    this.#stagedResult = accepted;
    this.sendEvent(event);
  }

  #acceptNodeFailure(error: Error): void { this.#stagedFailure = error; this.sendEvent('execution:failed'); }

  #settleTerminal(terminal: 'DONE' | 'BLOCKED' | 'FAILED', context: ActorLifecycleContext): void {
    if (context.source === null) throw new Error(`Process terminal '${terminal}' cannot be an initial state.`);
    const failure = this.#stagedFailure;
    const accepted = this.#stagedResult;
    if (context.event === 'execution:failed') { if (!failure || accepted) throw new Error(`FAILED terminal has invalid staged failure state.`); }
    else {
      if (!accepted || failure || context.event !== `result:${accepted.outcome}`) throw new Error(`Process terminal '${terminal}' has invalid staged result state.`);
      const route = this.process.definition.states.get(context.source)?.on.get(context.event);
      if (route?.target !== context.target) throw new Error(`Process terminal route disagrees with compiled definition.`);
    }
    if (this.#currentExecutingLlm?.executingActivity().mode === 'waiting' && !this.#joiningLlmActors) throw new Error(`Processor '${this.cardId}' settled while its current LLM actor was waiting.`);
    this.#currentExecutingLlm = null;
    this.#runtimeProjectionChanged();
    if (!this.#joiningLlmActors) {
      for (const llm of this.#activeLlmActors.values()) llm.abandonParkedTurn();
      const hadActors = this.#activeLlmActors.size > 0;
      this.#activeLlmActors.clear();
      if (hadActors) this.#runtimeProjectionChanged();
    }
    if (failure && isRuntimeStoppedInterruption(failure)) this.#result!.reject(failure);
    else {
      const summary = failure?.message ?? accepted!.summary;
      const outcome: ProcessOutcome = terminal === 'DONE'
        ? { status: 'done', summary, result: { kind: 'done', summary } }
        : terminal === 'BLOCKED'
          ? { status: 'blocked', summary, result: { kind: 'blocked', summary, resume_reason: summary } }
          : { status: 'failed', summary, result: { kind: 'failed', summary } };
      this.#result!.resolve(outcome);
    }
    this.#activationInput = null;
    this.#activationSignal = null;
    this.#stagedResult = null;
    this.#stagedFailure = null;
    this.#activationSettled = true;
  }

  #createMainLlm(agentId: string): ConversationLLMActor {
    const existing = this.#activeLlmActors.get(agentId); if (existing) return existing;
    const llm = new ConversationLLMActor({ projectRoot: this.projectRoot, agentId, provider: this.#provider, conversations: this.#conversations, gate: this.#gate, compactor: this.#compactor, summarizerProvider: this.#summarizerProvider, runtimeProjectionChanged: this.#runtimeProjectionChanged });
    this.#activeLlmActors.set(agentId, llm); this.#runtimeProjectionChanged(); return llm;
  }
  #selectExecutingLlm(llm: ConversationLLMActor): void { const current = this.#currentExecutingLlm; if (!current) { this.#currentExecutingLlm = llm; llm.resetExecutingActivity(); this.#runtimeProjectionChanged(); return; } if (current === llm) return; current.assertInvocationCanHandoff(); if (current.executingActivity().mode !== 'active') throw new Error(`Processor '${this.cardId}' cannot hand off an LLM actor while waiting.`); this.#currentExecutingLlm = llm; llm.resetExecutingActivity(); this.#runtimeProjectionChanged(); }
  #freshSourceInputId(): string { return randomUUID(); }
  #assertCurrentActivation(input: CardActivationInput): void { if (this.#activationInput !== input || this.#activationSettled) throw new Error(`Card process '${this.cardId}' activation is no longer current.`); }
  async #joinProcessorActivation(): Promise<readonly InvocationJoinOutcome[]> { const tracker = this.#operationTracker; if (!tracker) { await this.awaitLifecycleSettlement(); return []; } const outcome = await tracker.join(); await this.awaitLifecycleSettlement(); return [outcome]; }
}
