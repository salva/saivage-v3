import { createHash } from 'node:crypto';
import { cardParentId } from '../../schemas/card-id.js';
import { z } from 'zod';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { zodToJsonSchemaMini } from '../../agents/zod-to-jsonschema-mini.js';
import type { ToolDefinition as LlmToolDefinition } from '../../agents/llm-contracts.js';
import { cardAgentSessionId, type AgentName, type CardRecord, type ConversationSessionId } from '../../schemas/index.js';
import type { CardActivationInput, PlannerChildControlPort } from './card-activation-owner.js';
import type { CardService } from '../../cards/card-service.js';
import { describeNodeResultContract, processNodeOutcomes, processNodeTransition, processTransitionPromptKey, type CompiledCardTypeWorkflow, type ProcessNodeMetadata } from '../card-process/card-process-config.js';
import type { ActorTransitionContext } from '../micro-actor/index.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import type { ConversationLLMActor } from './llm-actor.js';
import type { PreparedLlmInvocationInput } from './llm-invocation.js';
import { readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import { formatPromptToolList } from '../../utils/prompt-api.js';
import { cardBootstrapForPrompt } from '../records/card-bootstrap.js';
import { appendActivationMarker, appendUserContextMessage, providerConversationProjection, type ProviderVisibleUserContextMessage } from './conversation-session.js';
import { stabilizeAgentSession } from './conversation-recovery.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from './compaction/compactor.js';
import { buildAgentSurface } from '../../tools/agent-invocation-surface.js';
import { cleanupInvocationSurface, invokeToolForLlm, surfaceToolDefinitions, type InvocationSurface } from '../../tools/invocation.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import { AuthoredRecordNotFoundError, type RecordProjection } from '../../persistence/authored-record-files.js';
import { PublicationOutcomeUnknownError, throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';
import type { Candidate } from '../../contracts/provider-candidate.js';

export interface AcceptedNodeResult {
  readonly nodeId: string;
  readonly agentName: AgentName;
  readonly outcome: string;
  readonly summary: string;
  readonly acceptedRecords: readonly Readonly<{ name: string; url: string; version: number }>[];
}

export type NodeTransition = Readonly<{ context: ActorTransitionContext; acceptedResult: AcceptedNodeResult | null }>;

type NodeResult = { outcome: string; summary: string };
type RecordEvidence = { version: number; revisionSeq: number; state: string; recordUrl: string } | null;
type ReviewerSnapshot = { cards: Array<{ id: string; fingerprint: string }>; includedRecordVersions: Array<{ cardId: string; filename: string; latest: number | null; contentHash: string | null }> };
type ReviewerContextPair = { exactContext: ProviderVisibleUserContextMessage; snapshot: ReviewerSnapshot };

export const EmitResultSettlementSchema = z.union([
  z.object({ success: z.literal(true), data: z.object({ accepted: z.literal(true) }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.string().min(1) }).strict(),
  z.object({ success: z.literal(false), error: z.string().min(1), data: z.object({ reason: z.literal('pending_notifications') }).strict() }).strict(),
]);

export type EmitResultSettlement = z.infer<typeof EmitResultSettlementSchema>;

export function parseEmitResultSettlement(value: unknown): EmitResultSettlement {
  return EmitResultSettlementSchema.parse(value);
}

export interface AgentNodeExecutionHost {
  createLlm(agentId: string): ConversationLLMActor;
  selectLlm(llm: ConversationLLMActor): void;
  freshInputId(): string;
  assertCurrentActivation(input: CardActivationInput): void;
  assertPromotionAvailable(process: CompiledCardTypeWorkflow, stateId: string, outcome: string): void;
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
  processPrompts: ProcessPromptRegistry;
  conversations: ConversationFileContext;
  compactionConfig: AutonomousCompactionPolicy;
  candidateChains:ReadonlyMap<AgentName,readonly Candidate[]>;
}

export class AgentNodeExecution {
  readonly #stabilizedAgents = new Set<AgentName>();
  constructor(readonly deps: AgentNodeExecutionDeps, readonly host: AgentNodeExecutionHost) {}

  beginActivation(): void { this.#stabilizedAgents.clear(); }

  async execute(args: { process: CompiledCardTypeWorkflow; stateId: string; node: ProcessNodeMetadata; transition: NodeTransition; input: CardActivationInput; signal: AbortSignal; nodeOrdinal: number }): Promise<AcceptedNodeResult> {
    const { process, stateId, node, input, signal } = args;
    const outcomes = processNodeOutcomes(process, stateId) as [string, ...string[]];
    const nodeResultSchema = z.object({ outcome: z.enum(outcomes), summary: z.string().trim().min(1).max(2000) }).strict();
    const terminalToolDefinition: LlmToolDefinition = { type: 'function', function: { name: TERMINAL_RESULT_TOOL_NAME, description: 'Emit the configured process-node result as the final action of this turn.', parameters: zodToJsonSchemaMini(nodeResultSchema) as Record<string, unknown> } };
    const contractDescription = describeNodeResultContract(process, stateId);
    const sessionId = cardAgentSessionId(node.agent.name, this.deps.cardId);
    const llm = this.host.createLlm(sessionId);
    this.host.selectLlm(llm);
    const needsProcessScope = node.agent.tools.some((name) => name === 'run_command' || name === 'wait_process' || name === 'kill_process');
    const scope = needsProcessScope ? this.executorScope(input, args.nodeOrdinal) : null;
    const surface = this.buildSurface(node, input, sessionId, scope, args.nodeOrdinal);
    let cleanupStatus: 'done' | 'blocked' | 'failed' | 'cancelled' = 'failed';
    let reviewerPair = node.descendantContext ? this.captureReviewerPair(input.card.id, node.descendantContext.records.map((record)=>record.name)) : null;
    let primaryCompletion: { kind: 'success'; value: AcceptedNodeResult } | { kind: 'failure'; reason: unknown };
    try {
      const inputId = this.host.freshInputId();
      this.prepareNodeEntry(process, node, args.transition, input, sessionId, inputId, reviewerPair);
      const baseline = new Map(node.requirements.map((record) => [record.definition.name, this.captureRecord(record.definition.name)]));
      const prepared = this.buildLlmInput(node, input, sessionId, inputId, contractDescription, surface, terminalToolDefinition);
      const terminalHandoff = () => this.host.assertCurrentActivation(input);
      let outcome = await llm.turn(prepared, signal, terminalHandoff);
      this.host.assertCurrentActivation(input);
      for (;;) {
        if (outcome.type === 'result') {
          this.host.assertCurrentActivation(input);
          outcome = await llm.continueAfterPlainText(this.correction(node, ['emit_result is required.']), signal, terminalHandoff);
          this.host.assertCurrentActivation(input);
          continue;
        }
        if (outcome.type === 'error') throw new Error(outcome.error);
        if (outcome.toolName === TERMINAL_RESULT_TOOL_NAME) {
          const terminalOutcome = outcome;
          let nodeResult: NodeResult;
          try {
            if (!outcome.args || typeof outcome.args !== 'object' || Array.isArray(outcome.args)) {
              throw new Error(`Terminal tool '${outcome.toolName}' arguments must be a JSON object.`);
            }
            const parsed = nodeResultSchema.safeParse(outcome.args);
            if (!parsed.success) throw new Error(parsed.error.message);
            nodeResult = parsed.data;
          }
          catch (error) { throwIfPublicationOutcomeUnknown(error); outcome = await llm.appendToolResult(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: false, error: this.correction(node, [errorMessage(error)]) }), signal); continue; }
          const route = processNodeTransition(process, stateId, nodeResult.outcome);
          const target = process.states.get(route.target);
          if (!target || (target.kind !== 'node' && target.kind !== 'terminal')) throw new Error(`Compiled node '${node.nodeId}' has invalid target '${route.target}'.`);
          const selected = input.notificationDelivery.selectNotifications();
          if (selected.length > 0) {
            const messages: ProviderVisibleUserContextMessage[] = [
              ...selected.map((notification) => ({ role: 'user' as const, content: notification.content })),
              { role: 'user', content: this.correction(node, ['pending_notifications: reconsider the appended context, update required records if needed, and call emit_result again.']) },
            ];
            outcome = await llm.appendToolResult(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: false, error: 'emit_result was not accepted because operator context is pending.', data: { reason: 'pending_notifications' } }), signal, () => ({ messages, afterAppend: () => input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id)) }));
            continue;
          }
          const records = this.validateRecords(node, baseline);
          if ('violations' in records) { outcome = await llm.appendToolResult(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: false, error: this.correction(node, records.violations) }), signal); continue; }
          if (reviewerPair) {
            const stale = this.reviewerStaleReason(input.card.id, reviewerPair.snapshot, node.descendantContext!.records.map((record)=>record.name));
            if (stale) {
              for(const requirement of node.requirements)if(requirement.kind==='updated')this.discardOpenRecord(requirement.definition.name, 'stale_descendant_context');
              const refreshed = this.captureReviewerPair(input.card.id,node.descendantContext!.records.map((record)=>record.name));
              const messages = [refreshed.exactContext, { role: 'user' as const, content: this.correction(node, [`Descendant context is stale: ${stale}. Recreate required records and call emit_result again.`]) }];
              outcome = await llm.appendToolResult(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: false, error: `Review context is stale: ${stale}.` }), signal, () => ({ messages, afterAppend: () => { reviewerPair = refreshed; } }));
              continue;
            }
          }
           if (target.kind === 'terminal' && target.terminal === 'DONE') {
            const blocker = firstIncompleteDescendant(input.card.id, this.deps.store);
            if (blocker) { outcome = await llm.appendToolResult(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: false, error: this.correction(node, [`Completion gate failed: descendant '${blocker.id}' is '${blocker.status}'.`]) }), signal); continue; }
          }
           if (target.kind === 'terminal') { this.host.assertPromotionAvailable(process,stateId,nodeResult.outcome);llm.claimResultAndCloseContinuation(terminalOutcome, new Error('Terminal result accepted.'), () => input.claimResult()); }
           this.host.assertCurrentActivation(input);
           const acceptedRecords = this.closeAcceptedRecords(node, records.candidates);
           await llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, parseEmitResultSettlement({ success: true, data: { accepted: true } }));
           this.host.assertCurrentActivation(input);
           cleanupStatus = target.kind === 'terminal' ? terminalCleanupStatus(target.terminal) : 'done';
           const accepted = Object.freeze({ nodeId:node.nodeId,agentName:node.agent.name,outcome: nodeResult.outcome, summary: nodeResult.summary, acceptedRecords: Object.freeze(acceptedRecords) });
           this.host.assertCurrentActivation(input);
           primaryCompletion = { kind: 'success', value: accepted };
           break;
        }
        const toolResult = surface.tools.has(outcome.toolName)
          ? await invokeToolForLlm(surface, outcome.toolName, outcome.args, llm.toolInvocationContext(outcome), signal)
          : { success: false as const, error: `Unsupported ${node.agent.name} tool call '${outcome.toolName}'.` };
        signal.throwIfAborted();
        this.host.assertCurrentActivation(input);
        outcome = await llm.appendToolResult(outcome.toolCallId, toolResult, signal, (continuationInputId) => this.ordinaryNotificationContext(input, continuationInputId));
      }
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      primaryCompletion = { kind: 'failure', reason: error };
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

  private prepareNodeEntry(process: CompiledCardTypeWorkflow, node: ProcessNodeMetadata, transition: NodeTransition, input: CardActivationInput, sessionId: ConversationSessionId, inputId: string, reviewerPair: ReviewerContextPair | null): void {
    if (!this.#stabilizedAgents.has(node.agent.name)) {
      if (!input.alreadyStabilizedAgents.has(node.agent.name)) stabilizeAgentSession({ sessionId, conversations: this.deps.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) });
      this.#stabilizedAgents.add(node.agent.name);
      appendActivationMarker(this.deps.conversations, sessionId, { event: 'activation_open', agent_name: node.agent.name, card_id: this.deps.cardId, input_id: inputId });
    } else {
      appendActivationMarker(this.deps.conversations, sessionId, { event: 'activation_open', agent_name: node.agent.name, card_id: this.deps.cardId, input_id: inputId });
    }
    const roleContext: ProviderVisibleUserContextMessage[] = [];
    const selected = input.notificationDelivery.selectNotifications();
    roleContext.push(...selected.map((notification) => ({ role: 'user' as const, content: notification.content })));
    if (reviewerPair) roleContext.push(reviewerPair.exactContext);
    roleContext.forEach((message, index) => appendUserContextMessage(this.deps.conversations, sessionId, inputId, message === reviewerPair?.exactContext ? 'reviewer_descendant' : 'notification', index, message));
    if (selected.length > 0) input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id));
    const transitionMessage = this.transitionContext(process, input.card, transition);
    if (transitionMessage) appendUserContextMessage(this.deps.conversations, sessionId, inputId, 'process_transition', 0, transitionMessage);
    appendUserContextMessage(this.deps.conversations, sessionId, inputId, 'process_node', 0, { role: 'user', content: this.deps.processPrompts.get(input.card.type, node.promptId) });
  }

  private transitionContext(process: CompiledCardTypeWorkflow, card: CardRecord, transition: NodeTransition): ProviderVisibleUserContextMessage | null {
    const { context, acceptedResult } = transition;
    const promptId = process.transitionPrompts.get(processTransitionPromptKey(context.source, context.event));
    if (context.source.startsWith('entry:')) {
      const entry = context.source.slice('entry:'.length);
      if (entry === 'STOPPED') {
        if (!promptId) throw new Error('STOPPED process entry has no configured prompt.');
        return { role: 'user', content: `The prior live card process was lost or stopped. Its graph position was discarded; recover from current durable facts.\n\n${this.deps.processPrompts.get(card.type, promptId)}` };
      }
      return promptId ? { role: 'user', content: this.deps.processPrompts.get(card.type, promptId) } : null;
    }
    if (!acceptedResult || context.event !== `result:${acceptedResult.outcome}` || context.source !== `node:${context.source.slice('node:'.length)}`) throw new Error('Node transition context disagrees with its staged accepted result.');
    const edgePrompt = promptId ? `\n\n${this.deps.processPrompts.get(card.type, promptId)}` : '';
    return { role: 'user', content: `Previous process node: ${context.source.slice('node:'.length)}\nAccepted outcome: ${acceptedResult.outcome}\nSummary: ${acceptedResult.summary}\nRecords:\n${acceptedResult.acceptedRecords.map((record) => `- ${record.url}`).join('\n') || '(none)'}${edgePrompt}` };
  }

  private buildLlmInput(node: ProcessNodeMetadata, input: CardActivationInput, sessionId: ConversationSessionId, inputId: string, contractDescription: string, surface: InvocationSurface, terminalToolDefinition: LlmToolDefinition): PreparedLlmInvocationInput {
    const systemPrompt = this.deps.promptTemplates.render(input.card.type, node.agent.name, {
      cardId: input.card.id, cardTitle: input.card.title, cardBrief: cardBootstrapForPrompt(this.deps.store, input.card), contractDescription,
      toolList: formatPromptToolList(surfaceToolDefinitions(surface)), cardType: input.card.type,
    });
    const tools = [...surfaceToolDefinitions(surface), terminalToolDefinition];
    const candidateChain=this.deps.candidateChains.get(node.agent.name);if(!candidateChain)throw new Error(`Bound candidate chain for agent '${node.agent.name}' is missing.`);return { inputId, agentId: sessionId, agentName: node.agent.name, sessionId, systemPrompt, providerConversation: providerConversationProjection(readConversation(this.deps.conversations.projectRoot, sessionId)), tools, terminalToolNames: [TERMINAL_RESULT_TOOL_NAME], modelParams: {temperature:node.agent.model.temperature}, preparedCompaction: prepareCompaction(this.deps.compactionConfig, systemPrompt, tools,node.agent.model.maxTokens), capabilityRequest: { requiresTools: true },candidateChain, episodeContext: { cardId: input.card.id, caller: input.caller, children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.lifecycle.status, type: card.type, title: card.title })) } };
  }

  private buildSurface(node: ProcessNodeMetadata, input: CardActivationInput, sessionId: ConversationSessionId, scope: ManagedProcessScope | null, nodeOrdinal: number): InvocationSurface {
    return buildAgentSurface({agentName:node.agent.name,toolNames:node.agent.tools,projectRoot:this.deps.projectRoot,cardId:input.card.id,sessionId,store:this.deps.store,parentControl:this.deps.parentControl,notifyCard:this.deps.notifyCard,childCreationTypes:node.childCreationTypes,childActivationTypes:node.childActivationTypes,processRunner:this.deps.processRunner,...(scope?{processScope:scope,processOwnerId:`${input.activationId}:node:${nodeOrdinal}`}:{ }),mcpToolInvocation:this.deps.mcpToolInvocation});
  }

  private executorScope(input: CardActivationInput, ordinal: number): ManagedProcessScope {
    if (!input.activationId) throw new Error(`Card process '${this.deps.cardId}' requires activationId for executor node ownership.`);
    return this.deps.processRunner.createDirectScope(this.deps.runtimeProcessRootScope, `card-activation:${input.activationId}:node:${ordinal}`, 'runtime_card');
  }

  private correction(node: ProcessNodeMetadata, violations: readonly string[]): string { return `${this.deps.processPrompts.get(this.deps.store.read(this.deps.cardId)!.type, node.correctionPromptId)}\n\nValidation errors:\n${violations.map((value) => `- ${value}`).join('\n')}`; }
  private ordinaryNotificationContext(input: CardActivationInput, _inputId: string) { const selected = input.notificationDelivery.selectNotifications(); return selected.length === 0 ? undefined : { messages: selected.map((notification) => ({ role: 'user' as const, content: notification.content })), afterAppend: () => input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id)) }; }

  private captureRecord(filename: string): RecordEvidence { const projection = readCandidate(this.deps.store, this.deps.cardId, filename, false); return projection ? evidence(projection) : null; }
  private validateRecords(node: ProcessNodeMetadata, baseline: ReadonlyMap<string, RecordEvidence>): { candidates: Map<string, RecordProjection> } | { violations: string[] } {
    const candidates = new Map<string, RecordProjection>(); const violations: string[] = [];
    for (const required of node.requirements) {
      const filename=required.definition.name;
      const candidate = required.kind==='updated'?readCandidate(this.deps.store, this.deps.cardId, filename, true):readClosedCandidate(this.deps.store,this.deps.cardId,filename);
      if (!candidate) { violations.push(`Required record 'record:///${filename}?card=${encodeURIComponent(this.deps.cardId)}' is missing or empty.`); continue; }
      if (required.kind==='updated') {
        const before = baseline.get(filename) ?? null;
        if (candidate.artifact.state !== 'open' || (before && compareRecord(candidate, before) <= 0)) { violations.push(`Required record '${candidate.recordUrl}' must be an open revision updated after this node began.`); continue; }
      }
      candidates.set(filename, candidate);
    }
    return violations.length > 0 ? { violations } : { candidates };
  }
  private closeAcceptedRecords(node: ProcessNodeMetadata, candidates: ReadonlyMap<string, RecordProjection>): Array<{name:string;url:string;version:number}> {
    const currentCard = this.deps.store.read(this.deps.cardId); if (!currentCard) throw new Error(`Card '${this.deps.cardId}' disappeared before record closure.`);
    const accepted:Array<{name:string;url:string;version:number}>=[];for(const requirement of node.requirements){const filename=requirement.definition.name;const candidate=candidates.get(filename)!;if(candidate.artifact.state!=='open'){accepted.push({name:filename,url:candidate.recordUrl,version:candidate.version});continue;}const closed=this.deps.store.closeRecord(this.deps.cardId,filename,candidate.version,node.agent.name as never,currentCard.version_seq);accepted.push({name:filename,url:closed.recordUrl,version:closed.version});}return accepted;
  }
  private discardOpenRecord(filename: string, reason: string): void { try { const open = this.deps.store.readRecord(this.deps.cardId, filename, 'open'); this.deps.store.discardRecord(this.deps.cardId, filename, open.version, reason); } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return; throw error; } }
  private directChildren(cardId: string): CardRecord[] { return this.deps.store.listChildren(cardId).map((id) => this.deps.store.read(id)).filter((card): card is CardRecord => card !== null); }
  private descendants(cardId: string): CardRecord[] { return this.directChildren(cardId).flatMap((child) => [child, ...this.descendants(child.id)]); }
  private captureReviewerPair(cardId: string,records:readonly string[]): ReviewerContextPair { const snapshot = this.captureReviewerSnapshot(cardId,records); return { exactContext: this.reviewerContext(cardId, snapshot), snapshot }; }
  private captureReviewerSnapshot(cardId: string,records:readonly string[]): ReviewerSnapshot { const root = this.deps.store.read(cardId); if (!root) throw new Error(`Reviewed card '${cardId}' not found.`);const descendants=this.descendants(cardId); return { cards: [root, ...descendants].map((card) => ({ id: card.id, fingerprint: semanticCardFingerprint(card) })), includedRecordVersions: descendants.flatMap((card)=>records.map((record)=>closedRecordFingerprint(this.deps.store, card.id,record))) }; }
  private reviewerContext(cardId: string, snapshot: ReviewerSnapshot): ProviderVisibleUserContextMessage { const lines=this.descendants(cardId).map((card)=>{const records=snapshot.includedRecordVersions.filter((entry)=>entry.cardId===card.id).map((entry)=>entry.latest===null?`${entry.filename}=missing`:`record:///${entry.filename}?card=${encodeURIComponent(card.id)}&v=${entry.latest}`).join(', ');return `- ${card.id} (${card.type}, ${card.lifecycle.status}): ${card.title}; ${records}`;}); return { role: 'user', content: `Descendant work:\n${lines.length ? lines.join('\n') : '(none)'}` }; }
  private reviewerStaleReason(cardId: string, before: ReviewerSnapshot,records:readonly string[]): string | null { const after = this.captureReviewerSnapshot(cardId,records); return JSON.stringify(before) === JSON.stringify(after) ? null : 'reviewed subtree or included records changed during review'; }
}

function terminalCleanupStatus(port: 'DONE' | 'BLOCKED' | 'FAILED'): 'done' | 'blocked' | 'failed' { return port === 'DONE' ? 'done' : port === 'BLOCKED' ? 'blocked' : 'failed'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readCandidate(store: CardService, cardId: string, filename: string, requireNonEmpty: boolean): RecordProjection | null { let open: RecordProjection | null = null; try { open = store.readRecord(cardId, filename, 'open'); } catch (error) { if (!(error instanceof AuthoredRecordNotFoundError)) throw error; } if (open && (!requireNonEmpty || open.artifact.content.trim())) return open; try { const closed = store.readRecord(cardId, filename, 'latest'); return !requireNonEmpty || closed.artifact.content.trim() ? closed : null; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return null; throw error; } }
function readClosedCandidate(store:CardService,cardId:string,filename:string):RecordProjection|null{try{const closed=store.readRecord(cardId,filename,'latest');return closed.artifact.content.trim()?closed:null;}catch(error){if(error instanceof AuthoredRecordNotFoundError)return null;throw error;}}
function evidence(value: RecordProjection): NonNullable<RecordEvidence> { return { version: value.version, revisionSeq: value.artifact.revision_seq, state: value.artifact.state, recordUrl: value.recordUrl }; }
function compareRecord(candidate: RecordProjection, baseline: NonNullable<RecordEvidence>): number { return candidate.version === baseline.version ? candidate.artifact.revision_seq - baseline.revisionSeq : candidate.version - baseline.version; }
function firstIncompleteDescendant(cardId: string, store: CardService): { id: string; status: string } | null { for (const childId of store.listChildren(cardId)) { const child = store.read(childId); if (!child) throw new Error(`Child '${childId}' was listed but not found.`); if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'cancelled') return { id: child.id, status: child.lifecycle.status }; const nested = firstIncompleteDescendant(childId, store); if (nested) return nested; } return null; }
function closedRecordFingerprint(store: CardService, cardId: string,filename:string): ReviewerSnapshot['includedRecordVersions'][number] { try { const record = store.readRecord(cardId, filename, 'latest'); return { cardId, filename, latest: record.version, contentHash: createHash('sha256').update(record.artifact.content).digest('hex') }; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return { cardId, filename, latest: null, contentHash: null }; throw error; } }
function semanticCardFingerprint(card: CardRecord): string { return createHash('sha256').update(JSON.stringify({ id: card.id, type: card.type, parent: cardParentId(card.id), children: card.children, title: card.title, status: card.lifecycle.status, lifecycle: card.lifecycle, depends_on: card.depends_on, related: card.related, tags: card.tags, priority: card.priority, urgency: card.urgency, metadata: card.metadata, metrics: card.metrics, status_text: card.status_text })).digest('hex'); }
