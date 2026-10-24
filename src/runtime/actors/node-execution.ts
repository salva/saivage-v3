import type {
  RuntimeOwnedBlockedResult,
  WorkflowExecutor,
  RecordAuthor,
} from '../../schemas/index.js';
import { invokeOperation } from './operation-execution.js';
import { resolveExecutionInputs, selectOperationRoute } from '../card-process/operation-routing.js';
import type { OperationValues } from '../card-process/operation-contract.js';
import type { CardService } from '../../cards/store-api.js';
import type { CardActivationInput, PlannerChildControlPort } from './card-activation-owner.js';
import type { ConversationLLMActor } from './llm-actor.js';
import type { ActorTransitionContext } from '../micro-actor/index.js';
import type { ConversationFileContext } from '../../persistence/session-api.js';
import type { PromptTemplateRegistry } from '../../utils/prompt-api.js';
import { renderCompiledPrompt } from '../../utils/prompt-api.js';
import type { McpToolInvocationPort } from '../../mcp/manager-api.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import type { AutonomousCompactionPolicy } from './compaction/compactor.js';
import { isEligibleRecordContent, type CurrentRecordProjection } from '../../persistence/index.js';
import { PublicationOutcomeUnknownError } from '../../contracts/index.js';
import { AgentExecutor } from './agent-executor.js';
import {
  agentCanWriteRecord,
  runtimeAgentBinding,
  requireAgentExecution,
  type CompiledCardTypeWorkflow,
  type CompiledNodeContract,
  type CompiledProcessTransition,
  type CompiledRuntimeWorkflows,
} from '../card-process/card-process-config.js';

export interface AcceptedNodeResult {
  readonly nodeId: string;
  readonly executor: WorkflowExecutor;
  readonly values: OperationValues;
  readonly outcome: string;
  readonly event: string;
  readonly summary: string;
  readonly acceptedRecords: readonly Readonly<{ name: string; url: string; version: number }>[];
}
export type NodeExecutionResult =
  | AcceptedNodeResult
  | RuntimeOwnedBlockedResult
  | Readonly<{ kind: 'node-interrupted'; ordinal: number }>;
export type NodeTransition = Readonly<{
  context: ActorTransitionContext;
  acceptedResult: AcceptedNodeResult | null;
  dataInputs?: OperationValues;
}>;
export interface NodeExecutionHost {
  createLlm(agentId: string): ConversationLLMActor;
  selectLlm(llm: ConversationLLMActor | null): void;
  freshInputId(): string;
  assertCurrentActivation(input: CardActivationInput): void;
  assertPromotionAvailable(transition: CompiledProcessTransition): void;
  claimResultHandoff(ordinal: number): void;
  claimedNodeInterruption(ordinal: number): boolean;
  retainSettlementFailure(error: unknown): void;
}
export interface NodeExecutionDeps {
  projectRoot: string;
  cardId: string;
  store: CardService;
  parentControl: PlannerChildControlPort;
  notifyCard: (
    cardId: string,
    notification: import('../../schemas/index.js').CardNotification,
  ) => import('../runtime-api.js').NotifyCardResult;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  mcpToolInvocation: McpToolInvocationPort;
  retrieval?: import('../../contracts/observed-collections.js').RetrievalPort;
  outboundHttp?: import('../../contracts/index.js').OutboundHttpEmitter;
  promptTemplates: PromptTemplateRegistry;
  conversations: ConversationFileContext;
  compactionConfig: AutonomousCompactionPolicy;
  workflows: CompiledRuntimeWorkflows;
}
export interface NodeExecutionArgs {
  process: CompiledCardTypeWorkflow;
  stateId: string;
  node: CompiledNodeContract;
  transition: NodeTransition;
  input: CardActivationInput;
  signal: AbortSignal;
  nodeOrdinal: number;
}
type CleanupStatus = 'done' | 'blocked' | 'failed' | 'cancelled';
type NodeAcceptance =
  | { violations: readonly string[]; message: string }
  | { stale: string }
  | { accepted: AcceptedNodeResult; cleanupStatus: CleanupStatus };
export interface AgentNodeContext {
  readonly scope: ManagedProcessScope | null;
  readonly writtenRecords: Set<string>;
  prepareRecords(): void;
  captureBaseline(): void;
  reprepareRecords(): void;
  finalizeRecords(): void;
  accept(
    candidate: { outcome: string; summary: string },
    reviewerStaleReason: () => string | null,
    beforeClaim: (terminal: boolean) => void,
  ): NodeAcceptance;
}

/** The graph owner supplies exact claims; execution owns fresh acceptance and resources. */
export class NodeExecution {
  private readonly agentExecutor: AgentExecutor;
  constructor(
    readonly deps: NodeExecutionDeps,
    readonly host: NodeExecutionHost,
  ) {
    this.agentExecutor = new AgentExecutor(deps, host);
  }

  async execute(args: NodeExecutionArgs): Promise<NodeExecutionResult> {
    const { node, input, signal } = args;
    if (node.execution.kind === 'action') return this.executeAction(args);
    const incoming = args.process.states
      .get(args.transition.context.source)
      ?.on.get(args.transition.context.event);
    const dataInputs = resolveExecutionInputs(
      node.execution.dataInputs,
      node.execution.inputs,
      incoming?.semantic.kind === 'configured-outcome' ? incoming.semantic.inputs : {},
      args.transition.acceptedResult?.values ?? {},
      { card_id: input.card.id, card_type: input.card.type, card_title: input.card.title },
    );
    args = { ...args, transition: { ...args.transition, dataInputs } };
    const scope = runtimeAgentBinding(this.deps.workflows, node.execution.agent.name).toolSet
      .requiresProcessScope
      ? this.executorScope(input, args.nodeOrdinal)
      : null;
    const writtenRecords = new Set<string>();
    let baseline = new Map<string, { revision: number; headId: string } | null>();
    let finalizationBegun = false;
    const context: AgentNodeContext = {
      scope,
      writtenRecords,
      prepareRecords: () => {
        this.prepareRecordRequirements(node);
      },
      captureBaseline: () => {
        baseline = new Map(
          node.requirements.map((record) => [
            record.definition.name,
            this.captureRecordHead(record.definition.name),
          ]),
        );
      },
      reprepareRecords: () => {
        finalizationBegun = true;
        this.discardWrittenRecords(writtenRecords);
        this.prepareRecordRequirements(node);
        finalizationBegun = false;
      },
      finalizeRecords: () => {
        if (finalizationBegun) return;
        finalizationBegun = true;
        this.discardWrittenRecords(writtenRecords);
      },
      accept: (candidate, stale, beforeClaim) =>
        this.acceptCandidate(
          args,
          candidate,
          baseline,
          stale,
          beforeClaim,
          () => {
            finalizationBegun = true;
          },
          writtenRecords,
        ),
    };
    let primary: { value: NodeExecutionResult } | { error: unknown };
    try {
      primary = { value: await this.agentExecutor.execute(args, context) };
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      primary = { error };
    }
    if (!finalizationBegun) {
      try {
        context.finalizeRecords();
      } catch (error) {
        if (error instanceof PublicationOutcomeUnknownError) throw error;
        primary = { error };
      }
    }
    if (scope) {
      const report = await this.deps.processRunner.closeAndTerminateDirectScope({
        directScope: scope,
        category: 'runtime_card',
        reason: signal.aborted ? 'activation interrupted' : 'activation settled',
      });
      if (report.failed.length > 0)
        throw new Error(
          report.failed
            .map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`)
            .join('; '),
        );
    }
    if (this.host.claimedNodeInterruption(args.nodeOrdinal)) {
      if ('error' in primary && primary.error !== signal.reason) throw primary.error;
      return { kind: 'node-interrupted', ordinal: args.nodeOrdinal };
    }
    if ('error' in primary) throw primary.error;
    return primary.value;
  }

  private async executeAction(args: NodeExecutionArgs): Promise<NodeExecutionResult> {
    const { node, input, signal, transition } = args;
    if (node.execution.kind !== 'action') throw new Error('Expected action execution.');
    signal.throwIfAborted();
    this.host.assertCurrentActivation(input);
    this.host.selectLlm(null);
    const baseline = new Map<string, { revision: number; headId: string } | null>();
    if (node.outputRecord) {
      const current = this.deps.store.readRecordCurrent(this.deps.cardId, node.outputRecord.name);
      if (current.kind !== 'found') throw new Error(`Card '${this.deps.cardId}' not found.`);
      const record = current.value.projection;
      if (record?.state === 'open')
        throw new Error(`Output destination '${node.outputRecord.name}' has an open draft.`);
      baseline.set(
        node.outputRecord.name,
        record ? { revision: record.revision, headId: record.headId } : null,
      );
    }
    const source = args.process.states.get(transition.context.source);
    const edge = source?.on.get(transition.context.event);
    const inputs = resolveExecutionInputs(
      node.execution.operation.inputs,
      node.execution.inputs,
      edge?.semantic.kind === 'configured-outcome' ? edge.semantic.inputs : {},
      transition.acceptedResult?.values ?? {},
      { card_id: input.card.id, card_type: input.card.type, card_title: input.card.title },
    );
    let invocation;
    try {
      invocation = await invokeOperation({
        projectRoot: this.deps.projectRoot,
        cardId: this.deps.cardId,
        execution: node.execution,
        inputs,
        collectOutput: node.outputRecord !== null,
        signal,
        processRunner: this.deps.processRunner,
        runtimeProcessRootScope: this.deps.runtimeProcessRootScope,
        retainSettlementFailure: (error) => this.host.retainSettlementFailure(error),
        binding: {
          kind: 'node',
          activation_id: input.activationId,
          node_id: node.nodeId,
          ordinal: args.nodeOrdinal,
        },
      });
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      if (this.host.claimedNodeInterruption(args.nodeOrdinal) && error === signal.reason)
        return { kind: 'node-interrupted', ordinal: args.nodeOrdinal };
      throw error;
    }
    signal.throwIfAborted();
    this.host.assertCurrentActivation(input);
    if (node.outputRecord) {
      const output = invocation.completedOutput;
      if (!output) throw new Error('Action output is not complete.');
      const author: RecordAuthor = {
        kind: 'action-output',
        operation: node.execution.operation.id,
        contract_version: node.execution.operation.contractVersion,
        provider: node.execution.operation.provider,
        activation_id: input.activationId,
        invocation_id: invocation.invocationId,
        node_id: node.nodeId,
        ordinal: args.nodeOrdinal,
        process_id: output.processId,
        output: output.descriptor,
        outcome: invocation.result.outcome,
        leader_exit: output.leaderExit,
      };
      this.deps.store.acceptRecord(
        this.deps.cardId,
        node.outputRecord.name,
        output.content,
        author,
      );
    }
    const routes = [...node.on.values()].flatMap((route) =>
      route.semantic.kind === 'configured-outcome'
        ? [
            {
              outcome: route.semantic.outcome,
              routeId: route.semantic.routeId,
              test: route.semantic.test,
            },
          ]
        : [],
    );
    const selected = selectOperationRoute(node.execution, routes, invocation.result);
    const acceptance = this.acceptCandidate(
      args,
      selected.result,
      baseline,
      () => null,
      () => {},
      () => {},
      new Set(),
      {
        kind: 'action',
        action: node.execution.operation.id,
        contract_version: node.execution.operation.contractVersion,
        provider: node.execution.operation.provider,
        invocation_id: invocation.invocationId,
      },
      selected.routeId,
      selected.result.values,
    );
    if ('accepted' in acceptance) return acceptance.accepted;
    throw new Error(
      'violations' in acceptance ? acceptance.violations.join('; ') : acceptance.stale,
    );
  }

  private acceptCandidate(
    args: NodeExecutionArgs,
    candidate: { outcome: string; summary: string },
    baseline: ReadonlyMap<string, { revision: number; headId: string } | null>,
    reviewerStaleReason: () => string | null,
    beforeClaim: (terminal: boolean) => void,
    beginFinalization: () => void,
    writtenRecords: ReadonlySet<string>,
    executor?: WorkflowExecutor,
    routeId = candidate.outcome,
    values: OperationValues = {},
  ): NodeAcceptance {
    const { node, process, input } = args;
    const route = node.on.get(`result:${routeId}`);
    if (!route || route.semantic.kind !== 'configured-outcome')
      throw new Error(
        `Compiled node '${node.nodeId}' has no configured outcome '${candidate.outcome}'.`,
      );
    const target = process.states.get(route.targetStateId);
    if (!target || (target.kind !== 'node' && target.kind !== 'terminal'))
      throw new Error(
        `Compiled node '${node.nodeId}' has invalid target '${route.targetStateId}'.`,
      );
    const records = this.validateRecords(node, baseline);
    if ('violations' in records) return { ...records, message: 'Record validation failed.' };
    const stale = reviewerStaleReason();
    if (stale) return { stale };
    if (target.kind === 'terminal' && target.terminal === 'DONE') {
      const blocker = firstIncompleteDescendant(input.card.id, this.deps.store);
      if (blocker) {
        const violation = `Completion gate failed: descendant '${blocker.id}' is '${blocker.status}'.`;
        return { violations: [violation], message: violation };
      }
    }
    if (target.kind === 'terminal') this.host.assertPromotionAvailable(route);
    let event = `result:${routeId}`;
    let selectedTarget = target;
    if (
      target.kind === 'terminal' &&
      target.terminal === 'DONE' &&
      (node.execution.kind !== 'agent' ||
        node.execution.agent.name !== process.notificationRecipient) &&
      input.notificationDelivery.hasPendingNotifications()
    ) {
      event = `${event}:pending-notifications`;
      const alternative = node.on.get(event);
      if (!alternative || alternative.semantic.kind !== 'configured-pending-notifications')
        throw new Error(
          `Compiled node '${node.nodeId}' has no pending-notifications alternative for accepted outcome '${candidate.outcome}'.`,
        );
      const alternativeTarget = process.states.get(alternative.targetStateId);
      if (
        !alternativeTarget ||
        alternativeTarget.kind !== 'node' ||
        alternativeTarget.execution.kind !== 'agent' ||
        alternativeTarget.execution.agent.name !== process.notificationRecipient
      )
        throw new Error(
          `Compiled node '${node.nodeId}' has an invalid pending-notifications target.`,
        );
      selectedTarget = alternativeTarget;
    }
    beforeClaim(selectedTarget.kind === 'terminal');
    this.host.claimResultHandoff(args.nodeOrdinal);
    this.host.assertCurrentActivation(input);
    beginFinalization();
    const acceptedRecords = this.closeAcceptedRecords(node, records.candidates, writtenRecords);
    return {
      accepted: Object.freeze({
        nodeId: node.nodeId,
        executor: executor ?? {
          kind: 'agent' as const,
          agent: requireAgentExecution(node).agent.name,
        },
        values,
        outcome: candidate.outcome,
        event,
        summary: candidate.summary,
        acceptedRecords: Object.freeze(acceptedRecords),
      }),
      cleanupStatus:
        selectedTarget.kind === 'terminal'
          ? terminalCleanupStatus(selectedTarget.terminal)
          : 'done',
    };
  }

  private executorScope(input: CardActivationInput, ordinal: number): ManagedProcessScope {
    if (!input.activationId)
      throw new Error(
        `Card process '${this.deps.cardId}' requires activationId for executor node ownership.`,
      );
    return this.deps.processRunner.createDirectScope(
      this.deps.runtimeProcessRootScope,
      `card-activation:${input.activationId}:node:${ordinal}`,
      'runtime_card',
    );
  }
  private prepareRecordRequirements(node: CompiledNodeContract): void {
    for (const definition of node.initializeRecords) {
      this.deps.store.initializeRecord(this.deps.cardId, definition.name, () => {
        const card = this.deps.store.read(this.deps.cardId);
        if (!card) throw new Error(`Card '${this.deps.cardId}' not found.`);
        return renderCompiledPrompt(
          { kind: 'record-initializer', cardType: card.type },
          definition.name,
          definition.initialization!.compiled,
          {
            cardType: card.type,
            cardId: card.id,
            cardTitle: card.title,
            nodeId: node.nodeId,
            recordName: definition.name,
          },
        );
      });
    }
    for (const requirement of node.requirements) {
      if (requirement.mode === 'continue') continue;
      const name = requirement.definition.name;
      const result = this.deps.store.readRecordCurrent(this.deps.cardId, name);
      if (result.kind === 'card-not-found')
        throw new Error(`Card '${this.deps.cardId}' not found.`);
      if (result.value.projection?.state === 'open')
        this.deps.store.discardRecord(this.deps.cardId, name);
      this.deps.store.openRecord(this.deps.cardId, name);
    }
  }
  private captureRecordHead(filename: string): { revision: number; headId: string } | null {
    const result = this.deps.store.readRecordCurrent(this.deps.cardId, filename);
    const projection = result.kind === 'found' ? result.value.projection : null;
    return projection ? { revision: projection.revision, headId: projection.headId } : null;
  }
  private validateRecords(
    node: CompiledNodeContract,
    baseline: ReadonlyMap<string, { revision: number; headId: string } | null>,
  ): { candidates: Map<string, CurrentRecordProjection> } | { violations: string[] } {
    const candidates = new Map<string, CurrentRecordProjection>();
    const violations: string[] = [];
    for (const required of node.requirements) {
      const filename = required.definition.name;
      const current =
        node.execution.kind === 'action'
          ? this.deps.store.readRecordCurrent(this.deps.cardId, filename)
          : null;
      const candidate = current
        ? current.kind === 'found'
          ? current.value.projection
          : null
        : readCandidate(this.deps.store, this.deps.cardId, filename);
      if (node.execution.kind === 'action') {
        const accepted = candidate?.accepted;
        if (!accepted || accepted.source_version <= 0 || !accepted.content.trim()) {
          violations.push(`Action requires accepted authored record '${filename}'.`);
          continue;
        }
        candidates.set(filename, candidate!);
        if (required.gate !== 'updated') continue;
      }
      if (!candidate) {
        violations.push(
          `Required record 'record:///${filename}?card=${encodeURIComponent(this.deps.cardId)}' is missing, empty or document 0; authored content is required.`,
        );
        continue;
      }
      if (required.gate === 'updated') {
        const before = baseline.get(filename) ?? null;
        if (candidate.headId === before?.headId || candidate.revision <= (before?.revision ?? 0)) {
          violations.push(
            `Required record '${candidate.currentUrl}' must be updated after this node began.`,
          );
          continue;
        }
      }
      candidates.set(filename, candidate);
    }
    return violations.length > 0 ? { violations } : { candidates };
  }
  private closeAcceptedRecords(
    node: CompiledNodeContract,
    candidates: ReadonlyMap<string, CurrentRecordProjection>,
    writtenRecords: ReadonlySet<string>,
  ): Array<{ name: string; url: string; version: number }> {
    const accepted: Array<{ name: string; url: string; version: number }> = [];
    const requiredNames = new Set<string>();
    for (const requirement of node.requirements) {
      const filename = requirement.definition.name;
      requiredNames.add(filename);
      if (node.execution.kind === 'action') {
        const candidate = candidates.get(filename)!;
        const snapshot = candidate.accepted!;
        accepted.push({
          name: filename,
          url: `${candidate.currentUrl}&v=${snapshot.source_version}`,
          version: snapshot.source_version,
        });
        continue;
      }
      if (!agentCanWriteRecord(requireAgentExecution(node).agent, filename))
        throw new Error(
          `Compiled node agent '${requireAgentExecution(node).agent.name}' cannot accept record '${filename}'.`,
        );
      const candidate = candidates.get(filename)!;
      if (candidate.state !== 'open') {
        const snapshot = candidate.accepted;
        if (!snapshot)
          throw new Error(
            `Accepted candidate '${this.deps.cardId}/${filename}' has no accepted content.`,
          );
        accepted.push({
          name: filename,
          url: `${candidate.currentUrl}&v=${snapshot.source_version}`,
          version: snapshot.source_version,
        });
        continue;
      }
      if (!candidate.draft || !isEligibleRecordContent(candidate))
        throw new Error(
          `Accepted open candidate '${this.deps.cardId}/${filename}' is empty or document 0.`,
        );
      const closed = this.deps.store.closeRecord(
        this.deps.cardId,
        filename,
        requireAgentExecution(node).agent.name,
      );
      const snapshot = closed.accepted!;
      accepted.push({
        name: filename,
        url: `${closed.currentUrl}&v=${snapshot.source_version}`,
        version: snapshot.source_version,
      });
    }
    for (const filename of [...writtenRecords].filter((name) => !requiredNames.has(name)).sort()) {
      if (!agentCanWriteRecord(requireAgentExecution(node).agent, filename))
        throw new Error(
          `Compiled node agent '${requireAgentExecution(node).agent.name}' cannot accept record '${filename}'.`,
        );
      const result = this.deps.store.readRecordCurrent(this.deps.cardId, filename);
      if (result.kind !== 'found' || !result.value.projection)
        throw new Error(`Written record '${this.deps.cardId}/${filename}' is missing.`);
      const current = result.value.projection;
      if (current.state !== 'open' || !current.draft || !isEligibleRecordContent(current))
        throw new Error(
          `Written record '${this.deps.cardId}/${filename}' is not a non-empty open draft.`,
        );
      this.deps.store.closeRecord(
        this.deps.cardId,
        filename,
        requireAgentExecution(node).agent.name,
      );
    }
    return accepted;
  }
  private discardWrittenRecords(writtenRecords: Set<string>): void {
    const names = [...writtenRecords].sort();
    writtenRecords.clear();
    for (const filename of names) {
      const result = this.deps.store.readRecordCurrent(this.deps.cardId, filename);
      if (result.kind === 'found' && result.value.projection?.state === 'open')
        this.deps.store.discardRecord(this.deps.cardId, filename);
    }
  }
}
function readCandidate(
  store: CardService,
  cardId: string,
  filename: string,
): CurrentRecordProjection | null {
  const result = store.readRecordCurrent(cardId, filename);
  if (result.kind === 'card-not-found' || !result.value.projection) return null;
  return isEligibleRecordContent(result.value.projection) ? result.value.projection : null;
}
function firstIncompleteDescendant(
  cardId: string,
  store: CardService,
): { id: string; status: string } | null {
  for (const childId of store.listChildren(cardId)) {
    const child = store.read(childId);
    if (!child) throw new Error(`Child '${childId}' was listed but not found.`);
    if (child.lifecycle.status !== 'done' && child.lifecycle.status !== 'cancelled')
      return { id: child.id, status: child.lifecycle.status };
    const nested = firstIncompleteDescendant(childId, store);
    if (nested) return nested;
  }
  return null;
}
function terminalCleanupStatus(port: 'DONE' | 'BLOCKED' | 'FAILED'): 'done' | 'blocked' | 'failed' {
  return port === 'DONE' ? 'done' : port === 'BLOCKED' ? 'blocked' : 'failed';
}
