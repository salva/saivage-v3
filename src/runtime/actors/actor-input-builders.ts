import { buildExecutorPrompt, buildPlannerPrompt, buildReviewerPrompt } from '../../agents/prompts/system-prompt.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { createPlannerContract } from '../../contracts/planner-contract.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { buildCardContextBlock, buildGoalContextBlock, buildGoalContextPayload, buildGoalEvidenceContext } from '../context-builder.js';
import { executorActorId, plannerActorId, reviewerActorId } from './ids.js';
import { XSTATE_PLANNER_TOOL_DEFINITIONS, XSTATE_PROCESS_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import type { LlmInvocationInput } from './llm-runner.js';
import type { RuntimeContextCardReader } from '../context-builder.js';
import type { XStateChildCard } from './xstate-child-activation.js';

export interface XStateActorInputContext {
  cards?: RuntimeContextCardReader;
}

export function buildXStatePlannerInput(input: {
  inputId: string;
  card: XStateChildCard;
  sourceCommandId?: string;
  context?: XStateActorInputContext;
}): Omit<LlmInvocationInput, 'agentId'> {
  return {
    inputId: input.inputId,
    role: 'planner',
    sessionId: plannerActorId(input.card.id),
    systemPrompt: buildPlannerSystemPrompt(input.card, input.context?.cards),
    contextMessages: [],
    tools: XSTATE_PLANNER_TOOL_DEFINITIONS,
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: { requiresTools: true },
    episodeContext: { cardId: input.card.id, cardType: input.card.type, sourceCommandId: input.sourceCommandId },
  };
}

export function buildXStateExecutorInput(input: {
  inputId: string;
  card: XStateChildCard;
  goalId: string;
  context?: XStateActorInputContext;
}): Omit<LlmInvocationInput, 'agentId'> {
  return {
    inputId: input.inputId,
    role: 'executor',
    sessionId: executorActorId(input.card.id),
    systemPrompt: buildExecutorSystemPrompt(input.card, input.goalId, input.context?.cards),
    contextMessages: [],
    tools: XSTATE_PROCESS_TOOL_DEFINITIONS,
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: { requiresTools: false },
    episodeContext: { cardId: input.card.id, cardType: input.card.type },
  };
}

export function buildXStateReviewerInput(input: {
  inputId: string;
  card: XStateChildCard;
  plannerSummary: string;
  context?: XStateActorInputContext;
}): Omit<LlmInvocationInput, 'agentId'> {
  return {
    inputId: input.inputId,
    role: 'reviewer',
    sessionId: reviewerActorId(input.card.id),
    systemPrompt: buildReviewerSystemPrompt(input.card, input.context?.cards),
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: { requiresTools: false },
    episodeContext: { cardId: input.card.id, cardType: input.card.type, plannerSummary: input.plannerSummary },
  };
}

function buildPlannerSystemPrompt(card: XStateChildCard, cards: RuntimeContextCardReader | undefined): string {
  const base = buildPlannerPrompt(createPlannerContract(), undefined, card.depth, undefined);
  if (!cards) return `${base}\n\n## Goal Context\n\n${JSON.stringify(card, null, 2)}`;
  const payload = buildGoalContextPayload({ goalId: card.id, resumeReason: 'initial', cards, notes: [], activeRun: null });
  return `${base}\n\n${buildGoalContextBlock({ goalId: card.id, resumeReason: 'initial', payload })}\n\n## Goal Evidence Context\n${buildGoalEvidenceContext({ goalId: card.id, cards })}`;
}

function buildExecutorSystemPrompt(card: XStateChildCard, goalId: string, cards: RuntimeContextCardReader | undefined): string {
  const base = buildExecutorPrompt(createExecutorContract(), card.type);
  if (!cards) return `${base}\n\n## Card Context\n\n${JSON.stringify({ card, goalId }, null, 2)}`;
  return `${base}\n\n${buildCardContextBlock({ cardId: card.id, goalId, cards })}`;
}

function buildReviewerSystemPrompt(card: XStateChildCard, cards: RuntimeContextCardReader | undefined): string {
  const base = buildReviewerPrompt(createReviewerContract());
  if (!cards) return `${base}\n\n## Goal Context\n\n${JSON.stringify(card, null, 2)}`;
  const payload = buildGoalContextPayload({ goalId: card.id, resumeReason: 'initial', cards, notes: [], activeRun: null });
  return `${base}\n\n${buildGoalContextBlock({ goalId: card.id, resumeReason: 'initial', payload })}\n\n## Goal Evidence Context\n${buildGoalEvidenceContext({ goalId: card.id, cards })}`;
}
