import { validateParsedCards } from '../cards/validator.js';
import type { RecordDefinition } from '../records/record-definition.js';
import type { CompiledCardTypeWorkflow, CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import { cardParentId } from '../schemas/card-id.js';
import { cardAgentSessionId, globalAgentSessionId, type AgentName, type ConversationSessionId } from '../schemas/index.js';
import { initializeAppLog } from './app-log.js';
import { readCurrentAuthoredRecord } from './authored-record-files.js';
import { readCanonicalLinkedCardHistoryTree, type CanonicalLinkedCardHistoryProjection } from './card-files.js';
import { readConversationCatalog, truncateCurrentConversationUnterminatedSuffix } from './conversation-file.js';

interface AdmittedCard {
  readonly projection: CanonicalLinkedCardHistoryProjection;
  readonly workflow: CompiledCardTypeWorkflow;
}

function cardConversationAgents(workflow: CompiledCardTypeWorkflow): AgentName[] {
  const names = new Set<AgentName>();
  for (const state of workflow.states.values()) if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
  return [...names].sort();
}

function definitions(workflow: CompiledCardTypeWorkflow): RecordDefinition[] {
  return [...workflow.records.values()].map((record) => ({ filename: record.name, format: record.format, schema: record.schema, bootstrap: record.bootstrap,declared:true }));
}

function requireConversationCatalog(projectRoot: string, sessionId: ConversationSessionId): void {
  try {
    readConversationCatalog(projectRoot, sessionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`Required conversation index for current configured session '${sessionId}' is missing from initialized generated state. Startup will not create a replacement session. Keep the service stopped; use the authorized reset-only cutover procedure with a full stopped backup before resetting generated history. Preserve configuration, credentials, operator inputs, source, and docs. Do not rename, merge, or selectively delete conversations.`, { cause: error });
  }
}

function admitCurrentCards(projectRoot: string, workflows: CompiledProjectWorkflows): readonly AdmittedCard[] {
  const projection = readCanonicalLinkedCardHistoryTree(projectRoot);
  if (projection.length === 0) throw new Error('Required project card authority is missing.');

  const activeCards = projection.filter(({ tombstone }) => tombstone === null).map(({ current }) => current);
  validateParsedCards({ cards: activeCards });

  const byId = new Map(projection.map((entry) => [entry.current.id, entry] as const));
  const admitted: AdmittedCard[] = [];
  for (const entry of projection) {
    if (entry.tombstone !== null) continue;
    const workflow = workflows.cardTypes.get(entry.current.type);
    if (!workflow) throw new Error(`No compiled workflow exists for card type '${entry.current.type}'.`);
    const parentId = cardParentId(entry.current.id);
    if (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent || parent.tombstone !== null) throw new Error(`Card '${entry.current.id}' has no reached active parent '${parentId}'.`);
      const parentWorkflow = workflows.cardTypes.get(parent.current.type);
      if (!parentWorkflow) throw new Error(`No compiled workflow exists for card type '${parent.current.type}'.`);
      if (!parentWorkflow.permittedChildTypes.has(entry.current.type)) throw new Error(`Card '${entry.current.id}' violates compiled parent/type admission.`);
    }
    admitted.push(Object.freeze({ projection: entry, workflow }));
  }
  return admitted;
}

export function initializeAndValidateCurrentGeneratedState(projectRoot: string, workflows: CompiledProjectWorkflows): void {
  const admitted = admitCurrentCards(projectRoot, workflows);
  const sessionIds: ConversationSessionId[] = [globalAgentSessionId(workflows.analyst.name)];
  for (const { projection, workflow } of admitted) {
    for (const agentName of cardConversationAgents(workflow)) sessionIds.push(cardAgentSessionId(agentName, projection.current.id));
  }
  for (const sessionId of sessionIds) requireConversationCatalog(projectRoot, sessionId);

  initializeAppLog(projectRoot);
  for (const sessionId of sessionIds) truncateCurrentConversationUnterminatedSuffix(projectRoot, sessionId);

  for (const { projection, workflow } of admitted) {
    const card = projection.current;
    for (const definition of definitions(workflow)) {
      const current = readCurrentAuthoredRecord(projectRoot, card, definition);
      if (definition.bootstrap && !current?.artifact.accepted) throw new Error(`Card '${card.id}' required bootstrap record '${definition.filename}' is unavailable.`);
    }
  }
}
