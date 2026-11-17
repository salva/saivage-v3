import { opendirSync } from 'node:fs';
import type { WorkGcProgressPort, WorkGcProtectionSource } from '../contracts/index.js';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { CompiledCardTypeWorkflow, CompiledProjectWorkflows } from '../runtime/runtime-api.js';
import { cardParentId } from '../schemas/index.js';
import {
  cardAgentSessionId,
  globalAgentSessionId,
  type AgentName,
  type ConversationSessionId,
  type RecordDefinition,
  type CardRecord,
  conversationSessionIdentity,
  recordHeadFilename,
  recordNameSchema,
} from '../schemas/index.js';
import { initializeAppLog } from './app-log.js';
import { readWorkGcRecord, readCurrentAuthoredRecord } from './authored-record-files.js';
import { readWorkGcCard, readWorkGcNotification, listCards } from './card-files.js';
import {
  isConversationCatalogEstablished,
  readConversationCatalog,
  readCurrentConversationSegment,
  readWorkGcConversation,
} from './conversation-file.js';
import { readWorkGcExecutionPaths } from './card-execution-log.js';
import { cardRecordsRoot } from './layout.js';
import { readProviderExchangeEntries } from './provider-exchange-log.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

export function workGcActionInputs(execution: {
  readonly operation: { readonly id: string };
  readonly config: unknown;
  readonly inputs: unknown;
}): unknown {
  if (execution.operation.id !== 'shell.run')
    return { config: execution.config, inputs: execution.inputs };
  const { script: _script, ...config } = execution.config as Record<string, unknown>;
  return { config, inputs: execution.inputs };
}

const STRICT_FAILURE_PROCEDURE =
  'Startup will not manufacture authority or use previous slots. Keep the service stopped, disable restarts, positively verify no owning process, preserve a fresh complete stopped-project backup, then use separately consented exact-target saivage repair where supported and restart separately. Unsupported damage may require an explicitly authorized whole-generated-state reset.';
function strictRead<T>(owner: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    const code = (error as NodeJS.ErrnoException).code;
    const category =
      code === 'ENOENT' ? 'missing' : code !== undefined ? 'unreadable' : 'malformed/inconsistent';
    throw new Error(
      `Strict canonical ${category} state for ${owner}. ${STRICT_FAILURE_PROCEDURE}`,
      { cause: error },
    );
  }
}

interface AdmittedCard {
  readonly card: CardRecord;
  readonly workflow: CompiledCardTypeWorkflow;
}

function cardConversationAgents(workflow: CompiledCardTypeWorkflow): AgentName[] {
  const names = new Set<AgentName>();
  for (const state of workflow.states.values())
    if (
      state.kind === 'node' &&
      state.execution.kind === 'agent' &&
      state.execution.agent.session === 'card'
    )
      names.add(state.execution.agent.name);
  return [...names].sort();
}

function definitions(workflow: CompiledCardTypeWorkflow): RecordDefinition[] {
  return [...workflow.records.values()].map((record) => ({
    filename: record.name,
    format: record.format,
    schema: record.schema,
    bootstrap: record.bootstrap,
    declared: true,
  }));
}

function requireConversationCatalog(projectRoot: string, sessionId: ConversationSessionId): void {
  try {
    readConversationCatalog(projectRoot, sessionId);
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      strictRead(`conversation index '${sessionId}'`, () => {
        throw error;
      });
    throw new Error(
      `Required conversation index for current configured session '${sessionId}' is missing from initialized generated state. Startup will not create a replacement session. ${STRICT_FAILURE_PROCEDURE}`,
      { cause: error },
    );
  }
}

function admitCurrentCards(
  projectRoot: string,
  workflows: CompiledProjectWorkflows,
): readonly AdmittedCard[] {
  const cards = strictRead('current linked card graph', () => listCards(projectRoot));
  if (cards.length === 0)
    throw new Error(`Required project card authority is missing. ${STRICT_FAILURE_PROCEDURE}`);

  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const admitted: AdmittedCard[] = [];
  for (const card of cards) {
    const workflow = workflows.cardTypes.get(card.type);
    if (!workflow) throw new Error(`No compiled workflow exists for card type '${card.type}'.`);
    const parentId = cardParentId(card.id);
    if (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent) throw new Error(`Card '${card.id}' has no reached active parent '${parentId}'.`);
      const parentWorkflow = workflows.cardTypes.get(parent.type);
      if (!parentWorkflow)
        throw new Error(`No compiled workflow exists for card type '${parent.type}'.`);
      if (!parentWorkflow.permittedChildTypes.has(card.type))
        throw new Error(`Card '${card.id}' violates compiled parent/type admission.`);
    }
    admitted.push(Object.freeze({ card, workflow }));
  }
  return admitted;
}

export function initializeAndValidateCurrentGeneratedState(
  projectRoot: string,
  workflows: CompiledProjectWorkflows,
): void {
  const admitted = admitCurrentCards(projectRoot, workflows);
  const sessionIds: ConversationSessionId[] = [globalAgentSessionId(workflows.analyst.name)];
  for (const { card, workflow } of admitted) {
    for (const agentName of cardConversationAgents(workflow))
      sessionIds.push(cardAgentSessionId(agentName, card.id));
  }
  for (const sessionId of sessionIds) requireConversationCatalog(projectRoot, sessionId);

  strictRead('shared app log', () => initializeAppLog(projectRoot));
  for (const sessionId of sessionIds)
    strictRead(`provider evidence '${sessionId}'`, () =>
      readProviderExchangeEntries(projectRoot, sessionId),
    );
  const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
  if (
    strictRead(`optional configured conversation index '${oversightSessionId}'`, () =>
      isConversationCatalogEstablished(projectRoot, oversightSessionId),
    )
  )
    strictRead(`provider evidence '${oversightSessionId}'`, () =>
      readProviderExchangeEntries(projectRoot, oversightSessionId),
    );
  for (const sessionId of sessionIds)
    strictRead(`current conversation '${sessionId}'`, () =>
      readCurrentConversationSegment(projectRoot, sessionId),
    );

  for (const { card, workflow } of admitted) {
    for (const definition of definitions(workflow)) {
      const current = strictRead(`record '${card.id}/${definition.filename}'`, () =>
        readCurrentAuthoredRecord(projectRoot, card, definition),
      );
      if (definition.bootstrap && !current?.accepted)
        throw new Error(
          `Card '${card.id}' required bootstrap record '${definition.filename}' is unavailable.`,
        );
    }
  }
}

/**
 * GC-only pure owning reads. No initialization, tail repair, previous-slot consumption or
 * canonical sibling discovery. Only current retention selections are consumed.
 */
export async function inspectWorkGcCanonicalState(
  projectRoot: string,
  workflows: CompiledProjectWorkflows,
  check: () => void,
  references: {
    readonly content: (
      value: unknown,
      cardId: string | null,
      source: WorkGcProtectionSource,
    ) => Promise<void>;
    readonly operational: (
      value: unknown,
      cardId: string | null,
      source: WorkGcProtectionSource,
    ) => Promise<void>;
    readonly done?: () => boolean;
  },
  progress?: WorkGcProgressPort,
): Promise<Map<string, number | null>> {
  const owners = new Map<string, number | null>();
  for (const path of new Set([
    workflows.analystPrompt.path,
    workflows.oversightPrompt.path,
    ...[...workflows.selectedGlobalParticipants.values()].map(
      (participant) => participant.prompt.path,
    ),
  ])) {
    if (references.done?.()) return owners;
    await references.operational({ path }, null, 'workflow_input');
  }
  async function conversation(
    session: ConversationSessionId,
    optional = false,
  ): Promise<number | null> {
    check();
    if (references.done?.()) return null;
    const { cardId } = conversationSessionIdentity(session);
    const projection = readWorkGcConversation(projectRoot, session, optional);
    for (const value of projection.references) {
      check();
      if (references.done?.()) return projection.horizon;
      await references.content(value, cardId, 'conversation_content');
      if (references.done?.()) return projection.horizon;
    }
    progress?.increment('inspected_sessions');
    await setImmediate();
    return projection.horizon;
  }
  const pending = ['project'];
  const reached = new Set<string>();
  while (pending.length) {
    check();
    if (references.done?.()) return owners;
    const id = pending.pop()!;
    if (reached.has(id)) throw new Error('Ambiguous GC card traversal.');
    reached.add(id);
    const card = readWorkGcCard(projectRoot, id);
    if (!card) continue;
    pending.push(...card.child_membership);
    await references.content([card.title, card.status_text], card.id, 'card_content');
    if (references.done?.()) return owners;
    owners.set(card.id, null);
    const workflow = workflows.cardTypes.get(card.type);
    if (!workflow) throw new Error('GC reached a card without a compiled workflow.');
    for (const notification of card.pending) {
      if (references.done?.()) return owners;
      await references.content(
        readWorkGcNotification(projectRoot, card.id, notification),
        card.id,
        'pending_notification',
      );
    }
    if (references.done?.()) return owners;
    const selectedDefinitions = new Map<string, Pick<RecordDefinition, 'filename' | 'bootstrap'>>(
      [...workflow.records.values()].map((record) => [
        record.name,
        { filename: record.name, bootstrap: record.bootstrap },
      ]),
    );
    const listed = new Set<string>();
    // The separate approved exception: names only, one level in this exact reached record root.
    const directory = opendirSync(cardRecordsRoot(projectRoot, card.id));
    try {
      for (;;) {
        check();
        const entry = directory.readSync();
        if (!entry) break;
        await setImmediate();
        check();
        if (entry.name.endsWith('.saivage-tmp')) continue;
        const match = /^record-([a-z][a-z0-9-]{0,63})\.json$/u.exec(entry.name);
        if (!match) continue;
        const filename = recordNameSchema.parse(`${match[1]}.md`);
        if (recordHeadFilename(filename) !== entry.name)
          throw new Error('GC record filename round-trip mismatch.');
        listed.add(filename);
        if (!selectedDefinitions.has(filename))
          selectedDefinitions.set(filename, { filename, bootstrap: false });
      }
    } finally {
      directory.closeSync();
    }
    for (const definition of selectedDefinitions.values())
      if (definition.bootstrap && !listed.has(definition.filename))
        throw new Error('Required GC bootstrap record is unavailable.');
    for (const filename of listed) {
      check();
      if (references.done?.()) return owners;
      for (const content of readWorkGcRecord(
        projectRoot,
        card.id,
        selectedDefinitions.get(filename)!,
      )) {
        await references.content(content, card.id, 'record_content');
        if (references.done?.()) return owners;
      }
      progress?.increment('inspected_records');
      await setImmediate();
    }
    if (references.done?.()) return owners;
    for (const path of readWorkGcExecutionPaths(projectRoot, card.id)) {
      if (references.done?.()) return owners;
      await references.operational(
        { path: resolve(projectRoot, path) },
        card.id,
        'unfinished_execution',
      );
    }
    for (const state of workflow.states.values()) {
      if (references.done?.()) return owners;
      if (state.kind !== 'node') continue;
      if (state.execution.kind === 'action')
        await references.operational(
          workGcActionInputs(state.execution),
          card.id,
          'workflow_input',
        );
      else {
        await references.operational(state.execution.inputs, card.id, 'workflow_input');
        await references.operational(
          { path: state.execution.selectedAgentPrompt.path },
          card.id,
          'workflow_input',
        );
      }
      for (const prompt of state.recordPrompts)
        await references.operational(
          { path: resolve(projectRoot, prompt.artifact.path) },
          card.id,
          'workflow_input',
        );
    }
    if (workflow.afterActivationCommit)
      await references.operational(
        workGcActionInputs(workflow.afterActivationCommit.execution),
        card.id,
        'workflow_input',
      );
    for (const prompt of workflow.processPrompts.values()) {
      if (references.done?.()) return owners;
      await references.operational({ path: prompt.path }, card.id, 'workflow_input');
    }
    const horizons: (number | null)[] = [];
    for (const agent of cardConversationAgents(workflow)) {
      if (references.done?.()) return owners;
      horizons.push(await conversation(cardAgentSessionId(agent, card.id)));
    }
    owners.set(
      card.id,
      horizons.length === 0 || horizons.includes(null) ? null : Math.min(...(horizons as number[])),
    );
    progress?.increment('inspected_cards');
    await setImmediate();
  }
  if (references.done?.()) return owners;
  if (!owners.has('project')) throw new Error('GC requires the canonical project card.');
  await conversation(globalAgentSessionId(workflows.analyst.name));
  if (references.done?.()) return owners;
  await conversation(globalAgentSessionId(workflows.oversight.name), true);
  if (references.done?.()) return owners;
  return owners;
}
