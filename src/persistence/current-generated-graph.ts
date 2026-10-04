import type { CompiledCardTypeWorkflow, CompiledProjectWorkflows } from '../runtime/runtime-api.js';
import { cardParentId } from '../schemas/index.js';
import {
  cardAgentSessionId,
  globalAgentSessionId,
  type AgentName,
  type ConversationSessionId,
  type RecordDefinition,
  type CardRecord,
} from '../schemas/index.js';
import { initializeAppLog } from './app-log.js';
import { readCurrentAuthoredRecord } from './authored-record-files.js';
import { listCards } from './card-files.js';
import {
  isConversationCatalogEstablished,
  readConversationCatalog,
  readCurrentConversationSegment,
} from './conversation-file.js';
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
    if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
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
