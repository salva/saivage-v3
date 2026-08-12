import { initializeMissingOptionalAuthoredRecord, readCurrentAuthoredRecord, recoverCurrentAuthoredRecordHead } from './authored-record-files.js';
import { listCards, readCurrentCardArtifact, recoverCurrentCardHead } from './card-files.js';
import { initializeMissingConversation, readCurrentConversationSegment, recoverCurrentConversationHead } from './conversation-file.js';
import { cardAgentSessionId, globalAgentSessionId, type AgentName, type CardRecord } from '../schemas/index.js';
import type { CompiledCardTypeWorkflow, CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import type { RecordDefinition } from '../records/record-definition.js';
import { initializeAppLog } from './app-log.js';

function cardConversationAgents(workflow: CompiledCardTypeWorkflow): AgentName[] {
  const names = new Set<AgentName>();
  for (const state of workflow.states.values()) if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
  return [...names].sort();
}

function definitions(workflow: CompiledCardTypeWorkflow): RecordDefinition[] {
  return [...workflow.records.values()].map((record) => ({ filename: record.name, writers: record.writers, format: record.format, schema: record.schema, bootstrap: record.bootstrap }));
}

export function validateCurrentGeneratedGraph(projectRoot: string, workflows: CompiledProjectWorkflows): void {
  readCurrentConversationSegment(projectRoot, globalAgentSessionId(workflows.analyst.name));
  const visited = new Set<string>();
  const visit = (cardId: string, parentWorkflow: CompiledCardTypeWorkflow | null): void => {
    if (visited.has(cardId)) throw new Error(`Current card graph reaches '${cardId}' more than once.`);
    visited.add(cardId);
    const result = readCurrentCardArtifact(projectRoot, cardId); if (result.kind === 'card-not-found') throw new Error(`Linked card '${cardId}' is missing.`);
    const terminal = result.value.kind === 'card-tombstone'; const card: CardRecord = terminal ? result.value.final_card : result.value.card;
    if (cardId === 'project' ? card.type !== 'project' || terminal : parentWorkflow === null || !parentWorkflow.permittedChildTypes.has(card.type)) throw new Error(`Card '${cardId}' violates compiled parent/type admission.`);
    const workflow = workflows.cardTypes.get(card.type); if (!workflow) throw new Error(`No compiled workflow exists for card type '${card.type}'.`);
    for (const agentName of cardConversationAgents(workflow)) readCurrentConversationSegment(projectRoot, cardAgentSessionId(agentName, card.id));
    if (!terminal) {
      for (const definition of definitions(workflow)) {
        const current = readCurrentAuthoredRecord(projectRoot, card.id, definition);
        if (definition.bootstrap && !current?.artifact.accepted) throw new Error(`Card '${card.id}' required bootstrap record '${definition.filename}' is unavailable.`);
      }
      for (const childId of card.children) visit(childId, workflow);
    }
  };
  visit('project', null);
  listCards(projectRoot);
}

export function initializeConfiguredOptionalState(projectRoot: string, workflows: CompiledProjectWorkflows): void {
  initializeAppLog(projectRoot);
  initializeMissingConversation(projectRoot, globalAgentSessionId(workflows.analyst.name));
  recoverCurrentConversationHead(projectRoot, globalAgentSessionId(workflows.analyst.name));
  const visit = (cardId: string): void => {
    recoverCurrentCardHead(projectRoot, cardId);
    const result = readCurrentCardArtifact(projectRoot, cardId); if (result.kind === 'card-not-found') throw new Error(`Linked card '${cardId}' is missing.`);
    const terminal = result.value.kind === 'card-tombstone'; const card = terminal ? result.value.final_card : result.value.card;
    const workflow = workflows.cardTypes.get(card.type); if (!workflow) throw new Error(`No compiled workflow exists for card type '${card.type}'.`);
    for (const agentName of cardConversationAgents(workflow)) { const sessionId = cardAgentSessionId(agentName, card.id); initializeMissingConversation(projectRoot, sessionId); recoverCurrentConversationHead(projectRoot, sessionId); }
    if (terminal) return;
    for (const definition of definitions(workflow)) {
      if (!definition.bootstrap) initializeMissingOptionalAuthoredRecord(projectRoot, card.id, definition);
      recoverCurrentAuthoredRecordHead(projectRoot, card.id, definition);
    }
    for (const childId of card.children) visit(childId);
  };
  visit('project');
}
