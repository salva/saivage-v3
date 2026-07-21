import { createHash } from 'node:crypto';
import { cardParentId } from '../../schemas/card-id.js';
import { z } from 'zod';
import type { Contract, ContractTerminalDescriptor } from '../../contracts/contract.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { zodToJsonSchemaMini } from '../../agents/zod-to-jsonschema-mini.js';
import type { CardRecord, ConversationSessionId } from '../../schemas/index.js';
import type { CardActivationInput, PlannerChildControlPort } from './card-activation-owner.js';
import type { CardService } from '../../cards/card-service.js';
import { processNodeOutcomes, processNodeTransition, processTransitionPromptKey, type CompiledCardProcess, type ProcessNodeMetadata, type ProcessRole } from '../card-process/card-process-config.js';
import type { ActorTransitionContext } from '../micro-actor/index.js';
import type { ProcessPromptRegistry } from '../card-process/process-prompt-registry.js';
import type { ConversationLLMActor, LLMActorOutcome } from './llm-actor.js';
import type { PreparedLlmInvocationInput } from './llm-invocation.js';
import { readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import { formatPromptToolList } from '../../utils/prompt-api.js';
import { cardBriefForPrompt } from '../records/card-brief.js';
import { appendActivationMarker, appendUserContextMessage, providerConversationProjection, type ProviderVisibleUserContextMessage } from './conversation-session.js';
import { stabilizeRoleSession } from './conversation-recovery.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from './compaction/compactor.js';
import { buildRoleSurface } from '../../tools/role-invocation-surfaces.js';
import { cleanupInvocationSurface, invokeToolForLlm, surfaceToolDefinitions, type InvocationSurface } from '../../tools/invocation.js';
import type { McpToolInvocationPort } from '../../mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import { plannerActorId, reviewerActorId, executorActorId } from './ids.js';
import { runContractRepairLoop } from './contract-repair-loop.js';
import { verifyTerminalToolOutcome } from './contract-terminal-tools.js';
import { AuthoredRecordNotFoundError, type RecordProjection } from '../../persistence/authored-record-files.js';

export interface AcceptedNodeResult {
  readonly outcome: string;
  readonly summary: string;
  readonly recordUrls: readonly string[];
}

export type NodeTransition = Readonly<{ context: ActorTransitionContext; acceptedResult: AcceptedNodeResult | null }>;

type NodeResult = { outcome: string; summary: string };
type NodeEnvelope = { kind: 'result'; payload: NodeResult };
type NodeTypedResult = { kind: 'result'; result: NodeResult };
type RecordEvidence = { version: number; revisionSeq: number; state: string; recordUrl: string } | null;
type ReviewerSnapshot = { cards: Array<{ id: string; fingerprint: string }>; includedRecordVersions: Array<{ cardId: string; filename: 'status.md'; latest: number | null; contentHash: string | null }> };
type ReviewerContextPair = { exactContext: ProviderVisibleUserContextMessage; snapshot: ReviewerSnapshot };

export interface AgentNodeExecutionHost {
  createLlm(agentId: string): ConversationLLMActor;
  selectLlm(llm: ConversationLLMActor): void;
  freshInputId(): string;
  assertCurrentActivation(input: CardActivationInput): void;
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
}

export class AgentNodeExecution {
  readonly #stabilizedRoles = new Set<ProcessRole>();
  constructor(readonly deps: AgentNodeExecutionDeps, readonly host: AgentNodeExecutionHost) {}

  beginActivation(): void { this.#stabilizedRoles.clear(); }

  async execute(args: { process: CompiledCardProcess; stateId: string; node: ProcessNodeMetadata; transition: NodeTransition; input: CardActivationInput; signal: AbortSignal; nodeOrdinal: number }): Promise<AcceptedNodeResult> {
    const { process, stateId, node, input, signal } = args;
    const contract = createNodeContract(process, stateId);
    const sessionId = sessionFor(node.role, this.deps.cardId);
    const llm = this.host.createLlm(sessionId);
    this.host.selectLlm(llm);
    const scope = node.role === 'executor' ? this.executorScope(input, args.nodeOrdinal) : null;
    const surface = this.buildSurface(node.role, input, sessionId, scope, args.nodeOrdinal);
    let cleanupStatus: 'done' | 'blocked' | 'failed' | 'cancelled' = 'failed';
    let reviewerPair = node.role === 'reviewer' ? this.captureReviewerPair(input.card.id) : null;
    try {
      const inputId = this.host.freshInputId();
      this.prepareNodeEntry(process, node, args.transition, input, sessionId, inputId, contract, surface, reviewerPair);
      const baseline = new Map(node.requiredRecords.map((record) => [record.filename, this.captureRecord(record.filename)]));
      const prepared = this.buildLlmInput(node, input, sessionId, inputId, contract, surface);
      const terminalHandoff = () => this.host.assertCurrentActivation(input);
      const initialOutcome = await llm.turn(prepared, signal, terminalHandoff);
      this.host.assertCurrentActivation(input);
      const accepted = await runContractRepairLoop<AcceptedNodeResult>({
        initialOutcome,
        isTerminalToolName: (name) => contract.isTerminalToolName(name),
        fail: (message) => { throw new Error(message); },
        onPlainText: async (_outcome, control) => control.repair(async () => {
          this.host.assertCurrentActivation(input);
          const repaired = await llm.continueAfterPlainText(this.correction(node, ['emit_result is required.']), signal, terminalHandoff);
          this.host.assertCurrentActivation(input);
          return repaired;
        }),
        onTerminalTool: async (terminalOutcome, control) => {
          let parsed: NodeResult;
          try { parsed = verifyTerminalToolOutcome(contract, terminalOutcome).result.result; }
          catch (error) { return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: this.correction(node, [errorMessage(error)]) }, signal)); }
          const route = processNodeTransition(process, stateId, parsed.outcome);
          const target = process.states.get(route.target);
          if (!target || (target.kind !== 'node' && target.kind !== 'terminal')) throw new Error(`Compiled node '${node.nodeId}' has invalid target '${route.target}'.`);
          const selected = input.notificationDelivery.selectNotifications();
          if (selected.length > 0) {
            const messages: ProviderVisibleUserContextMessage[] = [
              ...selected.map((notification) => ({ role: 'user' as const, content: notification.content })),
              { role: 'user', content: this.correction(node, ['pending_notifications: reconsider the appended context, update required records if needed, and call emit_result again.']) },
            ];
            return control.continue(await llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: 'emit_result was not accepted because operator context is pending.', data: { reason: 'pending_notifications' } }, signal, () => ({ messages, afterAppend: () => input.notificationDelivery.removeNotifications(selected.map((notification) => notification.id)) })));
          }
          const records = this.validateRecords(node, baseline);
          if ('violations' in records) return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: this.correction(node, records.violations) }, signal));
          if (reviewerPair) {
            const stale = this.reviewerStaleReason(input.card.id, reviewerPair.snapshot);
            if (stale) {
              this.discardOpenRecord('review.md', 'stale_review');
              const refreshed = this.captureReviewerPair(input.card.id);
              const messages = [refreshed.exactContext, { role: 'user' as const, content: this.correction(node, [`Review context is stale: ${stale}. Recreate review.md and call emit_result again.`]) }];
              return control.continue(await llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: `Review context is stale: ${stale}.` }, signal, () => ({ messages, afterAppend: () => { reviewerPair = refreshed; } })));
            }
          }
           if (target.kind === 'terminal' && target.terminal === 'DONE' && (input.card.type === 'project' || input.card.type === 'goal')) {
            const blocker = firstIncompleteDescendant(input.card.id, this.deps.store);
            if (blocker) return control.repair(() => llm.appendToolResult(terminalOutcome.toolCallId, { success: false, error: this.correction(node, [`Completion gate failed: descendant '${blocker.id}' is '${blocker.status}'.`]) }, signal));
          }
           if (target.kind === 'terminal') llm.claimResultAndCloseContinuation(terminalOutcome, new Error('Terminal result accepted.'), () => input.claimResult());
           this.host.assertCurrentActivation(input);
           const recordUrls = this.closeAcceptedRecords(node, records.candidates);
           await llm.settleToolResultWithoutContinuation(terminalOutcome.toolCallId, { success: true, data: { accepted: true } });
           this.host.assertCurrentActivation(input);
           cleanupStatus = target.kind === 'terminal' ? terminalCleanupStatus(target.terminal) : 'done';
           return control.done(Object.freeze({ outcome: parsed.outcome, summary: parsed.summary, recordUrls: Object.freeze(recordUrls) }));
        },
        onNonTerminalTool: async (toolOutcome) => {
          const toolResult = surface.tools.has(toolOutcome.toolName)
            ? await invokeToolForLlm(surface, toolOutcome.toolName, toolOutcome.args, llm.toolInvocationContext(toolOutcome), signal)
            : { success: false as const, error: `Unsupported ${node.role} tool call '${toolOutcome.toolName}'.` };
          signal.throwIfAborted();
          this.host.assertCurrentActivation(input);
          return llm.appendToolResult(toolOutcome.toolCallId, toolResult, signal, (continuationInputId) => this.ordinaryNotificationContext(input, continuationInputId));
        },
      });
      this.host.assertCurrentActivation(input);
      return accepted;
    } finally {
      await cleanupInvocationSurface(surface, { kind: 'activation_settled', status: signal.aborted ? 'cancelled' : cleanupStatus });
    }
  }

  private prepareNodeEntry(process: CompiledCardProcess, node: ProcessNodeMetadata, transition: NodeTransition, input: CardActivationInput, sessionId: ConversationSessionId, inputId: string, contract: Contract<NodeEnvelope, NodeTypedResult>, surface: InvocationSurface, reviewerPair: ReviewerContextPair | null): void {
    if (!this.#stabilizedRoles.has(node.role)) {
      if (!input.alreadyStabilizedRoles.has(node.role)) stabilizeRoleSession({ projectRoot: this.deps.projectRoot, sessionId, conversations: this.deps.conversations, terminalToolNames: new Set([TERMINAL_RESULT_TOOL_NAME]) });
      this.#stabilizedRoles.add(node.role);
      appendActivationMarker(this.deps.conversations, sessionId, { event: 'activation_open', role: node.role, card_id: this.deps.cardId, input_id: inputId });
    } else {
      appendActivationMarker(this.deps.conversations, sessionId, { event: 'activation_open', role: node.role, card_id: this.deps.cardId, input_id: inputId });
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
    void contract; void surface;
  }

  private transitionContext(process: CompiledCardProcess, card: CardRecord, transition: NodeTransition): ProviderVisibleUserContextMessage | null {
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
    return { role: 'user', content: `Previous process node: ${context.source.slice('node:'.length)}\nAccepted outcome: ${acceptedResult.outcome}\nSummary: ${acceptedResult.summary}\nRecords:\n${acceptedResult.recordUrls.map((url) => `- ${url}`).join('\n') || '(none)'}${edgePrompt}` };
  }

  private buildLlmInput(node: ProcessNodeMetadata, input: CardActivationInput, sessionId: ConversationSessionId, inputId: string, contract: Contract<NodeEnvelope, NodeTypedResult>, surface: InvocationSurface): PreparedLlmInvocationInput {
    const systemPrompt = this.deps.promptTemplates.render(input.card.type, node.role, {
      cardId: input.card.id, cardTitle: input.card.title, cardBrief: cardBriefForPrompt(this.deps.store, input.card), contractDescription: contract.describe(),
      toolList: formatPromptToolList(surfaceToolDefinitions(surface)), ...(node.role === 'executor' ? { cardType: input.card.type } : {}),
    });
    const tools = [...surfaceToolDefinitions(surface), ...contract.terminals.map((terminal) => terminal.toolDefinition)];
    return { inputId, agentId: sessionId, role: node.role, sessionId, systemPrompt, providerConversation: providerConversationProjection(readConversation(this.deps.projectRoot, sessionId)), tools, terminalToolNames: [TERMINAL_RESULT_TOOL_NAME], modelParams: {}, preparedCompaction: prepareCompaction(this.deps.compactionConfig, systemPrompt, tools), capabilityRequest: { requiresTools: true }, episodeContext: { cardId: input.card.id, caller: input.caller, ...(node.role === 'planner' ? { children: this.directChildren(input.card.id).map((card) => ({ id: card.id, status: card.lifecycle.status, type: card.type, title: card.title })) } : {}) } };
  }

  private buildSurface(role: ProcessRole, input: CardActivationInput, sessionId: ConversationSessionId, scope: ManagedProcessScope | null, nodeOrdinal: number): InvocationSurface {
    if (role === 'planner') return buildRoleSurface({ role: 'planner', projectRoot: this.deps.projectRoot, cardId: input.card.id, sessionId, store: this.deps.store, parentControl: this.deps.parentControl, notifyCard: this.deps.notifyCard });
    if (role === 'reviewer') return buildRoleSurface({ role: 'reviewer', projectRoot: this.deps.projectRoot, cardId: input.card.id, store: this.deps.store, mcpToolInvocation: this.deps.mcpToolInvocation });
    if (!scope) throw new Error(`Executor node for '${this.deps.cardId}' requires a node-local process scope.`);
    const ownerId = `${input.activationId}:node:${nodeOrdinal}`;
    return buildRoleSurface({ role: 'executor', projectRoot: this.deps.projectRoot, cardId: input.card.id, ownerId, store: this.deps.store, processRunner: this.deps.processRunner, processScope: scope, mcpToolInvocation: this.deps.mcpToolInvocation });
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
    for (const required of node.requiredRecords) {
      const candidate = readCandidate(this.deps.store, this.deps.cardId, required.filename, true);
      if (!candidate) { violations.push(`Required record 'record:///${required.filename}?card=${encodeURIComponent(this.deps.cardId)}' is missing or empty.`); continue; }
      if (required.updated) {
        const before = baseline.get(required.filename) ?? null;
        if (candidate.artifact.state !== 'open' || (before && compareRecord(candidate, before) <= 0)) { violations.push(`Required record '${candidate.recordUrl}' must be an open revision updated after this node began.`); continue; }
      }
      candidates.set(required.filename, candidate);
    }
    return violations.length > 0 ? { violations } : { candidates };
  }
  private closeAcceptedRecords(node: ProcessNodeMetadata, candidates: ReadonlyMap<string, RecordProjection>): string[] {
    const currentCard = this.deps.store.read(this.deps.cardId); if (!currentCard) throw new Error(`Card '${this.deps.cardId}' disappeared before record closure.`);
    return node.requiredRecords.map(({ filename }) => { const candidate = candidates.get(filename)!; if (candidate.artifact.state !== 'open') return candidate.recordUrl; const current = this.deps.store.readRecord(this.deps.cardId, filename, 'open'); return this.deps.store.closeRecord(this.deps.cardId, filename, current.version, node.role, currentCard.version_seq).recordUrl; });
  }
  private discardOpenRecord(filename: string, reason: string): void { try { const open = this.deps.store.readRecord(this.deps.cardId, filename, 'open'); this.deps.store.discardRecord(this.deps.cardId, filename, open.version, reason); } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return; throw error; } }
  private directChildren(cardId: string): CardRecord[] { return this.deps.store.listChildren(cardId).map((id) => this.deps.store.read(id)).filter((card): card is CardRecord => card !== null); }
  private descendants(cardId: string): CardRecord[] { return this.directChildren(cardId).flatMap((child) => [child, ...this.descendants(child.id)]); }
  private captureReviewerPair(cardId: string): ReviewerContextPair { const snapshot = this.captureReviewerSnapshot(cardId); return { exactContext: this.reviewerContext(cardId, snapshot), snapshot }; }
  private captureReviewerSnapshot(cardId: string): ReviewerSnapshot { const root = this.deps.store.read(cardId); if (!root) throw new Error(`Reviewed card '${cardId}' not found.`); return { cards: [root, ...this.descendants(cardId)].map((card) => ({ id: card.id, fingerprint: semanticCardFingerprint(card) })), includedRecordVersions: this.descendants(cardId).map((card) => closedRecordFingerprint(this.deps.store, card.id)) }; }
  private reviewerContext(cardId: string, snapshot: ReviewerSnapshot): ProviderVisibleUserContextMessage { const versions = new Map(snapshot.includedRecordVersions.map((entry) => [entry.cardId, entry.latest])); const lines = this.descendants(cardId).map((card) => `- ${card.id} (${card.type}, ${card.lifecycle.status}): ${card.title}; record=${versions.get(card.id) === null ? 'no closed status record' : `record:///status.md?card=${encodeURIComponent(card.id)}&v=${versions.get(card.id)}`}`); return { role: 'user', content: `Descendant work:\n${lines.length ? lines.join('\n') : '(none)'}` }; }
  private reviewerStaleReason(cardId: string, before: ReviewerSnapshot): string | null { const after = this.captureReviewerSnapshot(cardId); return JSON.stringify(before) === JSON.stringify(after) ? null : 'reviewed subtree or included status records changed during review'; }
}

function createNodeContract(process: CompiledCardProcess, stateId: string): Contract<NodeEnvelope, NodeTypedResult> {
  const node = process.states.get(stateId);
  if (!node || node.kind !== 'node') throw new Error(`Process '${process.family}' has no node state '${stateId}'.`);
  const nodeOutcomes = processNodeOutcomes(process, stateId);
  const outcomes = nodeOutcomes as [string, ...string[]];
  const schema = z.object({ outcome: z.enum(outcomes), summary: z.string().trim().min(1).max(2000) }).strict();
  const terminal: ContractTerminalDescriptor = { name: TERMINAL_RESULT_TOOL_NAME, description: 'Emit the configured process-node result as the final action of this turn.', schema, toolDefinition: { type: 'function', function: { name: TERMINAL_RESULT_TOOL_NAME, description: 'Emit the configured process-node result as the final action of this turn.', parameters: zodToJsonSchemaMini(schema) as Record<string, unknown> } } };
  return { name: `card-process:${node.nodeId}`, terminals: [terminal], describe: () => `Call emit_result with exactly two fields: outcome (one of: ${nodeOutcomes.join(' | ')}) and summary (a trimmed non-empty string of at most 2000 characters).`, isTerminalToolName: (name) => name === TERMINAL_RESULT_TOOL_NAME, verify: (call) => { if (call.name !== TERMINAL_RESULT_TOOL_NAME) return { ok: false, violation: { code: 'terminal_tool_unexpected', message: `Unexpected terminal tool '${call.name}'.`, locator: call.id } }; const parsed = schema.safeParse(call.args); return parsed.success ? { ok: true, terminalName: TERMINAL_RESULT_TOOL_NAME, envelope: { kind: 'result', payload: parsed.data } } : { ok: false, violation: { code: 'terminal_tool_invalid_envelope', message: parsed.error.message, locator: call.id } }; }, project: (envelope) => ({ kind: 'result', result: envelope.payload }) };
}
function sessionFor(role: ProcessRole, cardId: string): ConversationSessionId { return role === 'planner' ? plannerActorId(cardId) : role === 'reviewer' ? reviewerActorId(cardId) : executorActorId(cardId); }
function terminalCleanupStatus(port: 'DONE' | 'BLOCKED' | 'FAILED'): 'done' | 'blocked' | 'failed' { return port === 'DONE' ? 'done' : port === 'BLOCKED' ? 'blocked' : 'failed'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readCandidate(store: CardService, cardId: string, filename: string, requireNonEmpty: boolean): RecordProjection | null { let open: RecordProjection | null = null; try { open = store.readRecord(cardId, filename, 'open'); } catch (error) { if (!(error instanceof AuthoredRecordNotFoundError)) throw error; } if (open && (!requireNonEmpty || open.artifact.content.trim())) return open; try { const closed = store.readRecord(cardId, filename, 'latest'); return !requireNonEmpty || closed.artifact.content.trim() ? closed : null; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return null; throw error; } }
function evidence(value: RecordProjection): NonNullable<RecordEvidence> { return { version: value.version, revisionSeq: value.artifact.revision_seq, state: value.artifact.state, recordUrl: value.recordUrl }; }
function compareRecord(candidate: RecordProjection, baseline: NonNullable<RecordEvidence>): number { return candidate.version === baseline.version ? candidate.artifact.revision_seq - baseline.revisionSeq : candidate.version - baseline.version; }
function firstIncompleteDescendant(cardId: string, store: CardService): { id: string; status: string } | null { for (const childId of store.listChildren(cardId)) { const child = store.read(childId); if (!child) throw new Error(`Child '${childId}' was listed but not found.`); if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'cancelled') return { id: child.id, status: child.lifecycle.status }; const nested = firstIncompleteDescendant(childId, store); if (nested) return nested; } return null; }
function closedRecordFingerprint(store: CardService, cardId: string): ReviewerSnapshot['includedRecordVersions'][number] { try { const record = store.readRecord(cardId, 'status.md', 'latest'); return { cardId, filename: 'status.md', latest: record.version, contentHash: createHash('sha256').update(record.artifact.content).digest('hex') }; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return { cardId, filename: 'status.md', latest: null, contentHash: null }; throw error; } }
function semanticCardFingerprint(card: CardRecord): string { return createHash('sha256').update(JSON.stringify({ id: card.id, type: card.type, parent: cardParentId(card.id), children: card.children, title: card.title, status: card.lifecycle.status, lifecycle: card.lifecycle, depends_on: card.depends_on, related: card.related, tags: card.tags, priority: card.priority, urgency: card.urgency, metadata: card.metadata, metrics: card.metrics, status_text: card.status_text })).digest('hex'); }
