import { opendirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { CompiledCardTypeWorkflow, CompiledProjectWorkflows } from '../runtime/runtime-api.js';
import { cardParentId, genericRecordDefinition } from '../schemas/index.js';
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
import {
  iterateAuthoredRecordVersions,
  readCurrentAuthoredRecord,
} from './authored-record-files.js';
import {
  iterateCanonicalLinkedCardHistoryTree,
  listCards,
  readPendingCardNotifications,
} from './card-files.js';
import {
  isConversationCatalogEstablished,
  readConversationCatalog,
  readCurrentConversationSegment,
  inspectConversationIndex,
  inspectConversationSegment,
} from './conversation-file.js';
import { inspectCardExecutions } from './card-execution-log.js';
import { readCanonicalBytesOrMissing } from './growing-file.js';
import {
  cardRecordsRoot,
  cardConversationVersionIndexFile,
  globalAgentConversationVersionIndexFile,
} from './layout.js';
import { readProviderExchangeEntries } from './provider-exchange-log.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

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
 * canonical sibling discovery. The callback consumes complete values, never displayed excerpts.
 */
export async function inspectWorkGcCanonicalState(
  projectRoot: string,
  workflows: CompiledProjectWorkflows,
  check: () => void,
  reference: (value: unknown, cardId: string | null) => void,
): Promise<Set<string>> {
  const owners = new Set<string>();
  const types = new Map<string, string>();
  async function conversation(session: ConversationSessionId, optional = false): Promise<void> {
    check();
    const { agentName, cardId } = conversationSessionIdentity(session);
    const path =
      cardId === null
        ? globalAgentConversationVersionIndexFile(projectRoot, agentName)
        : cardConversationVersionIndexFile(projectRoot, cardId, agentName);
    const bytes = readCanonicalBytesOrMissing(path);
    if (bytes === null) {
      if (optional) return;
      throw new Error('Required GC conversation index is missing.');
    }
    const index = inspectConversationIndex(projectRoot, session, bytes);
    for (const entry of index.versions) {
      check();
      const inspected = inspectConversationSegment(projectRoot, session, index, entry.version);
      if (!inspected || inspected.tornSuffixLength !== 0)
        throw new Error(
          'GC requires complete selected conversation segments; no tail repair is performed.',
        );
      reference(inspected.projection, cardId);
      await setImmediate();
    }
  }
  for (const selection of iterateCanonicalLinkedCardHistoryTree(projectRoot)) {
    check();
    reference(selection.rows, selection.current.id);
    if (selection.tombstone) continue;
    const card = selection.current;
    owners.add(card.id);
    types.set(card.id, card.type);
    const workflow = workflows.cardTypes.get(card.type);
    if (!workflow) throw new Error('GC reached a card without a compiled workflow.');
    const parent = cardParentId(card.id);
    if (parent !== null) {
      const parentType = types.get(parent);
      if (!parentType || !workflows.cardTypes.get(parentType)!.permittedChildTypes.has(card.type))
        throw new Error('GC reached an invalid parent/type relationship.');
    }
    reference(readPendingCardNotifications(projectRoot, card.id), card.id);
    const selectedDefinitions = new Map<string, RecordDefinition>(
      definitions(workflow).map((d) => [d.filename, d]),
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
        if (!selectedDefinitions.has(filename)) {
          const definition = genericRecordDefinition(filename);
          selectedDefinitions.set(filename, {
            filename,
            format: definition.format,
            schema: definition.schema,
            bootstrap: definition.bootstrap,
            declared: false,
          });
        }
      }
    } finally {
      directory.closeSync();
    }
    for (const definition of selectedDefinitions.values()) {
      check();
      const current = readCurrentAuthoredRecord(projectRoot, card, definition);
      if (!current && listed.has(definition.filename))
        throw new Error('Listed GC record head disappeared.');
      if (definition.bootstrap && !current?.accepted)
        throw new Error('Required GC bootstrap record is unavailable.');
      reference(current, card.id);
      for (const version of iterateAuthoredRecordVersions(projectRoot, card, definition)) {
        check();
        reference(version, card.id);
        await setImmediate();
      }
      await setImmediate();
    }
    const executions = inspectCardExecutions(projectRoot, card.id);
    if (executions.tornSuffixLength)
      throw new Error('GC refuses torn execution evidence without mutation.');
    // Both action and native rows are included, including incomplete native capture/index
    // selections; execution endpoint links cannot hide selected work files.
    reference(executions.projection, card.id);
    for (const agent of cardConversationAgents(workflow))
      await conversation(cardAgentSessionId(agent, card.id));
    for (const state of workflow.states.values()) {
      if (state.kind !== 'node') continue;
      if (state.execution.kind === 'action')
        reference({ config: state.execution.config, inputs: state.execution.inputs }, card.id);
      else {
        reference(state.execution.inputs, card.id);
        reference({ path: state.execution.selectedAgentPrompt.path }, card.id);
      }
      for (const prompt of state.recordPrompts)
        reference({ path: resolve(projectRoot, prompt.artifact.path) }, card.id);
    }
    if (workflow.afterActivationCommit)
      reference(
        {
          config: workflow.afterActivationCommit.execution.config,
          inputs: workflow.afterActivationCommit.execution.inputs,
        },
        card.id,
      );
    for (const prompt of workflow.processPrompts.values())
      reference({ path: prompt.path }, card.id);
    await setImmediate();
  }
  if (!owners.has('project')) throw new Error('GC requires the canonical project card.');
  await conversation(globalAgentSessionId(workflows.analyst.name));
  await conversation(globalAgentSessionId(workflows.oversight.name), true);
  reference({ path: workflows.analystPrompt.path }, null);
  reference({ path: workflows.oversightPrompt.path }, null);
  for (const participant of workflows.selectedGlobalParticipants.values())
    reference({ path: participant.prompt.path }, null);
  return owners;
}
