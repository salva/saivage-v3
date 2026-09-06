import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import type { ToolDefinition as LlmToolDefinition } from '../../agents/llm-contracts.js';
import { canonicalJson, cardAgentSessionId, type AgentName, type CardRecord, type ContentPolicyRefusalBlockedResult, type ConversationSessionId } from '../../schemas/index.js';
import type { CardActivationInput, PlannerChildControlPort } from './card-activation-owner.js';
import type { CardService } from '../../cards/card-service.js';
import { agentCanWriteRecord, describeNodeResultContract, nodeResultSchema, nodeResultToolDefinition, runtimeAgentBinding, type CompiledCardTypeWorkflow, type CompiledNodeContract, type CompiledProcessTransition, type CompiledRuntimeWorkflows, type ProcessPromptId } from '../card-process/card-process-config.js';
import type { ActorTransitionContext } from '../micro-actor/index.js';
import type { ConversationLLMActor } from './llm-actor.js';
import type { PreparedLlmInvocationInput } from './llm-invocation.js';
import { readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import { cardBootstrapForPrompt } from '../records/card-bootstrap.js';
import { appendActivationMarker, appendUserContextMessage, providerConversationProjection, type ProviderVisibleUserContextMessage } from './conversation-session.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from './compaction/compactor.js';
import { cleanupInvocationSurface, EMIT_RESULT_POLICY_TEMPLATE, executedNoneSettlement, invokeToolForLlm, syntheticToolSettlement, surfaceToolDefinitions, type InvocationSurface, type ToolSettlementInput } from '../../tools/invocation.js';
import { buildPreparedInvocationContext, compileInvocationToolContract, type ContextBlock } from './context/context-blocks.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, surfaceToolContracts } from '../../tools/runtime-tool-catalog.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import { AuthoredRecordNotFoundError, type RecordProjection } from '../../persistence/authored-record-files.js';
import { PublicationOutcomeUnknownError, throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';
import { toolFailed, toolSucceeded } from '../../contracts/tool-result.js';

export interface AcceptedNodeResult {
  readonly nodeId: string;
  readonly agentName: AgentName;
  readonly outcome: string;
  readonly summary: string;
  readonly acceptedRecords: readonly Readonly<{ name: string; url: string; version: number }>[];
}
export type NodeExecutionResult = AcceptedNodeResult | ContentPolicyRefusalBlockedResult;

export type NodeTransition = Readonly<{ context: ActorTransitionContext; acceptedResult: AcceptedNodeResult | null }>;

type NodeResult = { outcome: string; summary: string };
type ReviewerSnapshot = { cards: Array<{ id: string; versionSeq: number }>; includedRecordVersions: Array<{ cardId: string; filename: string; sourceVersion: number | null }> };
type ReviewerContextPair = { exactContext: ProviderVisibleUserContextMessage; snapshot: ReviewerSnapshot };

export interface AgentNodeExecutionHost {
  createLlm(agentId: string): ConversationLLMActor;
  selectLlm(llm: ConversationLLMActor): void;
  freshInputId(): string;
  assertCurrentActivation(input: CardActivationInput): void;
  assertPromotionAvailable(transition: CompiledProcessTransition): void;
}

export interface AgentNodeExecutionDeps {
  projectRoot: string;
  cardId: string;
  store: CardService;
  parentControl: PlannerChildControlPort;
  notifyCard: (cardId: string, notification: import('../../schemas/index.js').CardNotification) => import('../runtime-api.js').NotifyCardResult;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  mcpToolInvocation: McpToolInvocationPort;
  promptTemplates: PromptTemplateRegistry;
  conversations: ConversationFileContext;
  compactionConfig: AutonomousCompactionPolicy;
  workflows: CompiledRuntimeWorkflows;
}

export class AgentNodeExecution {
  constructor(readonly deps: AgentNodeExecutionDeps, readonly host: AgentNodeExecutionHost) {}

  async execute(args: { process: CompiledCardTypeWorkflow; stateId: string; node: CompiledNodeContract; transition: NodeTransition; input: CardActivationInput; signal: AbortSignal; nodeOrdinal: number }): Promise<NodeExecutionResult> {
    const { process, stateId, node, input, signal } = args;
    const resultSchema = nodeResultSchema(process, stateId);
    const terminalToolDefinition = nodeResultToolDefinition(process, stateId);
    const contractDescription = describeNodeResultContract(process, stateId);
    const sessionId = cardAgentSessionId(node.agent.name, this.deps.cardId);
    const llm = this.host.createLlm(sessionId);
    this.host.selectLlm(llm);
    let reviewerPair = node.descendantContext ? this.captureReviewerPair(input.card.id, node.descendantContext.records.map((record)=>record.name)) : null;
    const binding = runtimeAgentBinding(this.deps.workflows, node.agent.name);
    const needsProcessScope = binding.toolSet.requiresProcessScope;
    const scope = needsProcessScope ? this.executorScope(input, args.nodeOrdinal) : null;
    const writtenRecords = new Set<string>();
    const surface = this.buildSurface(node, input, sessionId, scope, args.nodeOrdinal, writtenRecords);
    let cleanupStatus: 'done' | 'blocked' | 'failed' | 'cancelled' = 'failed';
    let recordFinalizationBegun = false;
    let primaryCompletion: { kind: 'success'; value: NodeExecutionResult } | { kind: 'failure'; reason: unknown };
    try {
      const prepared = this.prepareNodeInvocation(node, input, sessionId, contractDescription, surface, terminalToolDefinition, binding);
      this.prepareRecordRequirements(node);
      this.prepareNodeEntry(process, node, args.transition, input, sessionId, prepared.inputId, reviewerPair);
      const baseline = new Map(node.requirements.map((record) => [record.definition.name, this.captureRecordHead(record.definition.name)]));
      const preparedInput = this.enterNodeConversation(prepared);
      const terminalHandoff = () => this.host.assertCurrentActivation(input);
      let outcome = await llm.turn(preparedInput, signal, terminalHandoff);
      this.host.assertCurrentActivation(input);
      for (;;) {
        if (outcome.type === 'result') {
          this.host.assertCurrentActivation(input);
          outcome = await llm.continueAfterPlainText(this.correction(process, node, ['emit_result is required.']), signal, terminalHandoff);
          this.host.assertCurrentActivation(input);
          continue;
        }
        if (outcome.type === 'error') throw new Error(outcome.error);
        if (outcome.type === 'blocked') {
          cleanupStatus = 'blocked';
          primaryCompletion = { kind: 'success', value: outcome.result };
          break;
        }
        if (outcome.toolName === TERMINAL_RESULT_TOOL_NAME) {
          const terminalOutcome = outcome;
          let nodeResult: NodeResult;
          try {
            if (!outcome.args || typeof outcome.args !== 'object' || Array.isArray(outcome.args)) {
              throw new Error(`Terminal tool '${outcome.toolName}' arguments must be a JSON object.`);
            }
            const parsed = resultSchema.safeParse(outcome.args);
            if (!parsed.success) throw new Error(parsed.error.message);
            nodeResult = parsed.data;
          }
          catch (error) { throwIfPublicationOutcomeUnknown(error); outcome = (await llm.appendToolResult(terminalOutcome.toolCallId, executedNoneSettlement(toolFailed(this.correction(process, node, [errorMessage(error)]))), signal)).outcome; continue; }
          const route = node.on.get(`result:${nodeResult.outcome}`);
          if (!route || route.semantic.kind !== 'configured-outcome')
            throw new Error(
              `Compiled node '${node.nodeId}' has no configured outcome '${nodeResult.outcome}'.`,
            );
          const target = process.states.get(route.targetStateId);
          if (!target || (target.kind !== 'node' && target.kind !== 'terminal'))
            throw new Error(
              `Compiled node '${node.nodeId}' has invalid target '${route.targetStateId}'.`,
            );
          const selected = input.notificationDelivery.selectNotifications();
          if (selected.length > 0) {
            const messages: ProviderVisibleUserContextMessage[] = [
              ...selected.map((notification) => ({ role: 'user' as const, content: notification.content })),
              { role: 'user', content: this.correction(process, node, ['pending_notifications: reconsider the appended context, update required records if needed, and call emit_result again.']) },
            ];
            outcome = (await llm.appendToolResult(terminalOutcome.toolCallId, executedNoneSettlement(toolFailed('emit_result was not accepted because operator context is pending.', { reason: 'pending_notifications' })), signal, () => ({ messages, afterAppend: () => input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id)) }))).outcome;
            continue;
          }
          const records = this.validateRecords(node, baseline);
          if ('violations' in records) { outcome = (await llm.appendToolResult(terminalOutcome.toolCallId, executedNoneSettlement(toolFailed(this.correction(process, node, records.violations))), signal)).outcome; continue; }
          if (reviewerPair) {
            const stale = this.reviewerStaleReason(input.card.id, reviewerPair.snapshot, node.descendantContext!.records.map((record)=>record.name));
            if (stale) {
              recordFinalizationBegun = true;
              this.discardWrittenRecords(writtenRecords, 'stale_descendant_context');
              this.prepareRecordRequirements(node);
              recordFinalizationBegun = false;
              const refreshed = this.captureReviewerPair(input.card.id,node.descendantContext!.records.map((record)=>record.name));
              const messages = [refreshed.exactContext, { role: 'user' as const, content: this.correction(process, node, [`Descendant context is stale: ${stale}. Recreate required records and call emit_result again.`]) }];
              outcome = (await llm.appendToolResult(terminalOutcome.toolCallId, executedNoneSettlement(toolFailed(`Review context is stale: ${stale}.`)), signal, () => ({ messages, afterAppend: () => { reviewerPair = refreshed; } }))).outcome;
              continue;
            }
          }
           if (target.kind === 'terminal' && target.terminal === 'DONE') {
            const blocker = firstIncompleteDescendant(input.card.id, this.deps.store);
            if (blocker) { outcome = (await llm.appendToolResult(terminalOutcome.toolCallId, executedNoneSettlement(toolFailed(this.correction(process, node, [`Completion gate failed: descendant '${blocker.id}' is '${blocker.status}'.`]))), signal)).outcome; continue; }
          }
          if (target.kind === 'terminal') {
            this.host.assertPromotionAvailable(route);
            llm.claimResultAndCloseContinuation(
              terminalOutcome,
              new Error('Terminal result accepted.'),
              () => input.claimResult(),
            );
          }
          this.host.assertCurrentActivation(input);
          recordFinalizationBegun = true;
          const acceptedRecords = this.closeAcceptedRecords(node, records.candidates, writtenRecords);
          await llm.settleToolResultWithoutContinuation(
            terminalOutcome.toolCallId,
            executedNoneSettlement(toolSucceeded({ accepted: true })),
          );
          this.host.assertCurrentActivation(input);
          cleanupStatus =
            target.kind === 'terminal' ? terminalCleanupStatus(target.terminal) : 'done';
          const accepted = Object.freeze({
            nodeId: node.nodeId,
            agentName: node.agent.name,
            outcome: nodeResult.outcome,
            summary: nodeResult.summary,
            acceptedRecords: Object.freeze(acceptedRecords),
          });
          this.host.assertCurrentActivation(input);
          primaryCompletion = { kind: 'success', value: accepted };
          break;
        }
        const toolSettlement: ToolSettlementInput = surface.tools.has(outcome.toolName)
          ? await invokeToolForLlm(surface, outcome.toolName, outcome.args, llm.toolInvocationContext(outcome), signal)
          : syntheticToolSettlement('unsupported_tool', `Unsupported ${node.agent.name} tool call '${outcome.toolName}'.`);
        signal.throwIfAborted();
        this.host.assertCurrentActivation(input);
        outcome = (await llm.appendToolResult(outcome.toolCallId, toolSettlement, signal, (continuationInputId) => this.ordinaryNotificationContext(input, continuationInputId))).outcome;
      }
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      primaryCompletion = { kind: 'failure', reason: error };
    }
    if (!recordFinalizationBegun) {
      try {
        recordFinalizationBegun = true;
        this.discardWrittenRecords(writtenRecords, signal.aborted ? 'activation_cancelled' : `activation_${cleanupStatus}`);
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError) throw error;
        primaryCompletion = { kind: 'failure', reason: error };
      }
    }
    let cleanupCompletion: { kind: 'success' } | { kind: 'failure'; reason: unknown };
    try {
      await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: signal.aborted ? 'cancelled' : cleanupStatus });
      cleanupCompletion = { kind: 'success' };
    } catch (error) {
      cleanupCompletion = { kind: 'failure', reason: error };
    }
    if (cleanupCompletion.kind === 'failure') throw cleanupCompletion.reason;
    if (primaryCompletion.kind === 'failure') throw primaryCompletion.reason;
    return primaryCompletion.value;
  }

  private prepareNodeEntry(process: CompiledCardTypeWorkflow, node: CompiledNodeContract, transition: NodeTransition, input: CardActivationInput, sessionId: ConversationSessionId, inputId: string, reviewerPair: ReviewerContextPair | null): void {
    appendActivationMarker(this.deps.conversations, sessionId, { event: 'activation_open', agent_name: node.agent.name, card_id: this.deps.cardId, input_id: inputId });
    const roleContext: ProviderVisibleUserContextMessage[] = [];
    const selected = input.notificationDelivery.selectNotifications();
    roleContext.push(...selected.map((notification) => ({ role: 'user' as const, content: notification.content })));
    if (reviewerPair) roleContext.push(reviewerPair.exactContext);
    roleContext.forEach((message, index) => appendUserContextMessage(this.deps.conversations, sessionId, inputId, message === reviewerPair?.exactContext ? 'reviewer_descendant' : 'notification', index, message));
    if (selected.length > 0) input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id));
    const transitionMessage = this.transitionContext(process, transition);
    if (transitionMessage) appendUserContextMessage(this.deps.conversations, sessionId, inputId, 'process_transition', 0, transitionMessage);
    appendUserContextMessage(this.deps.conversations, sessionId, inputId, 'process_node', 0, { role: 'user', content: promptText(process, node.promptId) });
  }

  private transitionContext(process: CompiledCardTypeWorkflow, transition: NodeTransition): ProviderVisibleUserContextMessage | null {
    const { context, acceptedResult } = transition;
    const route = process.states.get(context.source)?.on.get(context.event);
    if (!route || route.targetStateId !== context.target)
      throw new Error(
        `Process transition context '${context.source}'/'${context.event}' is not compiled.`,
      );
    if (route.semantic.kind === 'entry-route') {
      const source = process.states.get(context.source)!;
      if (source.kind !== 'entry')
        throw new Error(`Entry transition context has non-entry source '${context.source}'.`);
      const promptId = route.semantic.promptId;
      if (source.entry === 'STOPPED') {
        if (!promptId) throw new Error('STOPPED process entry has no configured prompt.');
        return { role: 'user', content: `The prior live card process was lost or stopped. Its graph position was discarded; recover from current durable facts.\n\n${promptText(process, promptId)}` };
      }
      return promptId ? { role: 'user', content: promptText(process, promptId) } : null;
    }
    if (route.semantic.kind !== 'configured-outcome')
      throw new Error(
        `Node transition context '${context.source}'/'${context.event}' is not a configured outcome.`,
      );
    if (
      !acceptedResult ||
      context.event !== `result:${acceptedResult.outcome}` ||
      route.semantic.outcome !== acceptedResult.outcome
    )
      throw new Error('Node transition context disagrees with its staged accepted result.');
    const promptId = route.semantic.promptId;
    const edgePrompt = promptId ? `\n\n${promptText(process, promptId)}` : '';
    return { role: 'user', content: `Previous process node: ${context.source.slice('node:'.length)}\nAccepted outcome: ${acceptedResult.outcome}\nSummary: ${acceptedResult.summary}\nRecords:\n${acceptedResult.acceptedRecords.map((record) => `- ${record.url}`).join('\n') || '(none)'}${edgePrompt}` };
  }

  private prepareNodeInvocation(node: CompiledNodeContract, input: CardActivationInput, sessionId: ConversationSessionId, contractDescription: string, surface: InvocationSurface, terminalToolDefinition: LlmToolDefinition, binding: import('../card-process/card-process-config.js').BoundAgentContract): Omit<PreparedLlmInvocationInput, 'providerConversation'> {
    const cardBrief = cardBootstrapForPrompt(this.deps.store, input.card);
    const systemPrompt = this.deps.promptTemplates.render({kind:'workflow-agent',cardType:input.card.type}, node.agent.name, { contractDescription });
    const tools = [...surfaceToolDefinitions(surface), terminalToolDefinition];
    const compiledToolContracts = [...surfaceToolContracts(surface), compileInvocationToolContract(terminalToolDefinition, EMIT_RESULT_POLICY_TEMPLATE)];
    const preparedCompaction = prepareCompaction(this.deps.compactionConfig, systemPrompt, tools, binding.contract.model.maxTokens);
    const preparedContext = buildPreparedInvocationContext({ instructionText: systemPrompt, terminalToolNames: [TERMINAL_RESULT_TOOL_NAME], compiledTools: compiledToolContracts, dynamicBlocks: this.cardDynamicBlocks(input, cardBrief), preparedCompaction });
    return { inputId: this.host.freshInputId(), agentId: sessionId, agentName: node.agent.name, sessionId, systemPrompt, tools, compiledToolContracts, terminalToolNames: [TERMINAL_RESULT_TOOL_NAME], modelParams: {temperature:binding.contract.model.temperature}, preparedCompaction, preparedContext, capabilityRequest: binding.capabilityRequest,routePass:{kind:'ordinary',candidateChain:binding.candidateChain}, episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.lifecycle.status, type: card.type, title: card.title })) } };
  }

  private cardDynamicBlocks(input: CardActivationInput, cardBrief: string): readonly ContextBlock[] {
    const block: ContextBlock = {
      id: `card-activation:${input.card.id}`,
      role: 'system',
      content: canonicalJson({ cardId: input.card.id, cardType: input.card.type, title: input.card.title, brief: cardBrief }),
      storage: 'activation_local',
      replacement: { kind: 'retain' },
      audience: 'primary_and_summarizer',
      evidence: { kind: 'none' },
    };
    return [Object.freeze(block)];
  }

  private enterNodeConversation(prepared: Omit<PreparedLlmInvocationInput, 'providerConversation'>): PreparedLlmInvocationInput {
    return { ...prepared, providerConversation: providerConversationProjection(readConversation(this.deps.conversations.projectRoot, prepared.sessionId)) };
  }

  private buildSurface(node: CompiledNodeContract, input: CardActivationInput, sessionId: ConversationSessionId, scope: ManagedProcessScope | null, nodeOrdinal: number, writtenRecords: Set<string>): InvocationSurface {
    const references=effectiveCardNodeToolReferences(node.agent.tools,node.childCreationTypes);
    return new BoundAgentToolSet(references).bind({scope:'card',agentName:node.agent.name,projectRoot:this.deps.projectRoot,cardId:input.card.id,sessionId,store:this.deps.store,parentControl:this.deps.parentControl,notifyCard:this.deps.notifyCard,childCreationTypes:node.childCreationTypes,childActivationTypes:node.childActivationTypes,cardTypeVocabulary:this.deps.workflows.cardTypeVocabulary,processRunner:this.deps.processRunner,...(scope?{processScope:scope,processOwnerId:`${input.activationId}:node:${nodeOrdinal}`}:{ }),mcpToolInvocation:this.deps.mcpToolInvocation,onRecordWritten:(name)=>writtenRecords.add(name)});
  }

  private executorScope(input: CardActivationInput, ordinal: number): ManagedProcessScope {
    if (!input.activationId) throw new Error(`Card process '${this.deps.cardId}' requires activationId for executor node ownership.`);
    return this.deps.processRunner.createDirectScope(this.deps.runtimeProcessRootScope, `card-activation:${input.activationId}:node:${ordinal}`, 'runtime_card');
  }

  private correction(process: CompiledCardTypeWorkflow, node: CompiledNodeContract, violations: readonly string[]): string { return `${promptText(process, node.correctionPromptId)}\n\nValidation errors:\n${violations.map((value) => `- ${value}`).join('\n')}`; }
  private ordinaryNotificationContext(input: CardActivationInput, _inputId: string) { const selected = input.notificationDelivery.selectNotifications(); return selected.length === 0 ? undefined : { messages: selected.map((notification) => ({ role: 'user' as const, content: notification.content })), afterAppend: () => input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id)) }; }

  private prepareRecordRequirements(node: CompiledNodeContract): void {
    for (const requirement of node.requirements) {
      if (requirement.mode === 'continue') continue;
      const name = requirement.definition.name;
      const result=this.deps.store.readRecordCurrent(this.deps.cardId,name);if(result.kind==='card-not-found')throw new Error(`Card '${this.deps.cardId}' not found.`);const current=result.value.projection;
      if (current?.artifact.state === 'open') this.deps.store.discardRecord(this.deps.cardId, name, 'clean_node_entry');
      this.deps.store.openRecord(this.deps.cardId, name);
    }
  }
  private captureRecordHead(filename: string): number | null {const result=this.deps.store.readRecordCurrent(this.deps.cardId,filename);return result.kind==='found'?result.value.projection?.headVersion??null:null;}
  private validateRecords(node: CompiledNodeContract, baseline: ReadonlyMap<string, number | null>): { candidates: Map<string, RecordProjection> } | { violations: string[] } {
    const candidates = new Map<string, RecordProjection>(); const violations: string[] = [];
    for (const required of node.requirements) {
      const filename=required.definition.name;
      const candidate = readCandidate(this.deps.store, this.deps.cardId, filename);
      if (!candidate) { violations.push(`Required record 'record:///${filename}?card=${encodeURIComponent(this.deps.cardId)}' is missing or empty.`); continue; }
      if (required.gate==='updated') {
        const before = baseline.get(filename) ?? null;
        if (candidate.headVersion <= (before ?? 0)) { violations.push(`Required record '${candidate.currentUrl}' must be updated after this node began.`); continue; }
      }
      candidates.set(filename, candidate);
    }
    return violations.length > 0 ? { violations } : { candidates };
  }
  private closeAcceptedRecords(node: CompiledNodeContract, candidates: ReadonlyMap<string, RecordProjection>, writtenRecords: ReadonlySet<string>): Array<{name:string;url:string;version:number}> {
    const accepted:Array<{name:string;url:string;version:number}>=[];
    const requiredNames = new Set<string>();
    for(const requirement of node.requirements){
      const filename=requirement.definition.name;requiredNames.add(filename);
      if(!agentCanWriteRecord(node.agent, filename))throw new Error(`Compiled node agent '${node.agent.name}' cannot accept record '${filename}'.`);
      const candidate=candidates.get(filename)!;
      if(candidate.artifact.state!=='open'){
        const snapshot=candidate.artifact.accepted;if(!snapshot)throw new Error(`Accepted candidate '${this.deps.cardId}/${filename}' has no accepted content.`);
        accepted.push({name:filename,url:`${candidate.currentUrl}&v=${snapshot.source_version}`,version:snapshot.source_version});continue;
      }
      if(!candidate.artifact.draft||candidate.artifact.draft.content.trim().length===0)throw new Error(`Accepted open candidate '${this.deps.cardId}/${filename}' is empty.`);
      const closed=this.deps.store.closeRecord(this.deps.cardId,filename,node.agent.name);const snapshot=closed.artifact.accepted!;
      accepted.push({name:filename,url:`${closed.currentUrl}&v=${snapshot.source_version}`,version:snapshot.source_version});
    }
    for(const filename of [...writtenRecords].filter((name)=>!requiredNames.has(name)).sort()){
      if(!agentCanWriteRecord(node.agent, filename as never))throw new Error(`Compiled node agent '${node.agent.name}' cannot accept record '${filename}'.`);
      const result=this.deps.store.readRecordCurrent(this.deps.cardId,filename);if(result.kind!=='found'||!result.value.projection)throw new Error(`Written record '${this.deps.cardId}/${filename}' is missing.`);const current=result.value.projection;
      if(current.artifact.state!=='open'||!current.artifact.draft||current.artifact.draft.content.trim().length===0)throw new Error(`Written record '${this.deps.cardId}/${filename}' is not a non-empty open draft.`);
      this.deps.store.closeRecord(this.deps.cardId,filename,node.agent.name);
    }
    return accepted;
  }
  private discardWrittenRecords(writtenRecords: Set<string>, reason: string): void { const names=[...writtenRecords].sort();writtenRecords.clear();for(const filename of names){const result=this.deps.store.readRecordCurrent(this.deps.cardId,filename);const current=result.kind==='found'?result.value.projection:null;if(current?.artifact.state==='open')this.deps.store.discardRecord(this.deps.cardId,filename,reason);} }
  private directChildren(cardId: string): CardRecord[] { return this.deps.store.listChildren(cardId).map((id) => this.deps.store.read(id)).filter((card): card is CardRecord => card !== null); }
  private descendants(cardId: string): CardRecord[] { return this.directChildren(cardId).flatMap((child) => [child, ...this.descendants(child.id)]); }
  private captureReviewerPair(cardId: string,records:readonly string[]): ReviewerContextPair { const snapshot = this.captureReviewerSnapshot(cardId,records); return { exactContext: this.reviewerContext(cardId, snapshot), snapshot }; }
  private captureReviewerSnapshot(cardId: string,records:readonly string[]): ReviewerSnapshot { const root = this.deps.store.read(cardId); if (!root) throw new Error(`Reviewed card '${cardId}' not found.`);const descendants=this.descendants(cardId); return { cards: [root, ...descendants].map((card) => ({ id: card.id, versionSeq: card.version_seq })), includedRecordVersions: descendants.flatMap((card)=>records.map((record)=>acceptedRecordVersion(this.deps.store, card.id,record))) }; }
  private reviewerContext(cardId: string, snapshot: ReviewerSnapshot): ProviderVisibleUserContextMessage { const lines=this.descendants(cardId).map((card)=>{const records=snapshot.includedRecordVersions.filter((entry)=>entry.cardId===card.id).map((entry)=>entry.sourceVersion===null?`${entry.filename}=missing`:`record:///${entry.filename}?card=${encodeURIComponent(card.id)}&v=${entry.sourceVersion}`).join(', ');return `- ${card.id} (${card.type}, ${card.lifecycle.status}): ${card.title}; ${records}`;}); return { role: 'user', content: `Descendant work:\n${lines.length ? lines.join('\n') : '(none)'}` }; }
  private reviewerStaleReason(cardId: string, before: ReviewerSnapshot,records:readonly string[]): string | null { const after = this.captureReviewerSnapshot(cardId,records); return JSON.stringify(before) === JSON.stringify(after) ? null : 'reviewed subtree or included records changed during review'; }
}

function terminalCleanupStatus(port: 'DONE' | 'BLOCKED' | 'FAILED'): 'done' | 'blocked' | 'failed' { return port === 'DONE' ? 'done' : port === 'BLOCKED' ? 'blocked' : 'failed'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readCandidate(store: CardService, cardId: string, filename: string): RecordProjection | null {const result=store.readRecordCurrent(cardId,filename);if(result.kind==='card-not-found'||!result.value.projection)return null;const current=result.value.projection;const selected=current.artifact.state==='open'?current.artifact.draft?.content:current.artifact.accepted?.content;return selected?.trim()?current:null;}
function firstIncompleteDescendant(cardId: string, store: CardService): { id: string; status: string } | null { for (const childId of store.listChildren(cardId)) { const child = store.read(childId); if (!child) throw new Error(`Child '${childId}' was listed but not found.`); if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'cancelled') return { id: child.id, status: child.lifecycle.status }; const nested = firstIncompleteDescendant(childId, store); if (nested) return nested; } return null; }
function acceptedRecordVersion(store: CardService, cardId: string,filename:string): ReviewerSnapshot['includedRecordVersions'][number] {const result=store.readRecordCurrent(cardId,filename);const record=result.kind==='found'?result.value.projection:null;return {cardId,filename,sourceVersion:record?.artifact.accepted?.source_version??null};}
function promptText(process: CompiledCardTypeWorkflow, promptId: ProcessPromptId): string { const prompt=process.processPrompts.get(promptId);if(!prompt)throw new Error(`Compiled workflow '${process.cardType}' has no process prompt '${promptId}'.`);return prompt.text; }
