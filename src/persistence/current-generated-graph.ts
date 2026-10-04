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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `Required conversation index for current configured session '${sessionId}' is missing from initialized generated state. Startup will not create a replacement session. Keep the service stopped; use the authorized reset-only cutover procedure with a full stopped backup before resetting generated history. Preserve configuration, credentials, operator inputs, source, and docs. Do not rename, merge, or selectively delete conversations.`,
      { cause: error },
    );
  }
}

function admitCurrentCards(
  projectRoot: string,
  workflows: CompiledProjectWorkflows,
): readonly AdmittedCard[] {
  const cards = listCards(projectRoot);
  if (cards.length === 0) throw new Error('Required project card authority is missing.');

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

  initializeAppLog(projectRoot);
  for (const sessionId of sessionIds) readProviderExchangeEntries(projectRoot, sessionId);
  const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
  if (isConversationCatalogEstablished(projectRoot, oversightSessionId))
    readProviderExchangeEntries(projectRoot, oversightSessionId);
  for (const sessionId of sessionIds) readCurrentConversationSegment(projectRoot, sessionId);

  for (const { card, workflow } of admitted) {
    for (const definition of definitions(workflow)) {
      const current = readCurrentAuthoredRecord(projectRoot, card, definition);
      if (definition.bootstrap && !current?.accepted)
        throw new Error(
          `Card '${card.id}' required bootstrap record '${definition.filename}' is unavailable.`,
        );
    }
  }
}
