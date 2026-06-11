import { executorActorId, plannerActorId } from './ids.js';
import { XSTATE_PLANNER_TOOL_DEFINITIONS, XSTATE_PROCESS_TOOL_DEFINITIONS } from './actor-tool-definitions.js';
import { GoalCardRunnerController } from './goal-card-runner.js';
import { TerminalCardRunnerController } from './card-runner.js';
import type { ChildActivationOutcome, ChildActivationPort } from './goal-card-runner.js';
import type { GoalCardStatusPort } from './goal-card-runner.js';
import type { AdmissionPort, ProviderTurnPort } from './llm-runner.js';
import type { TerminalCardStatusPort } from './card-runner.js';

export interface XStateChildCard {
  id: string;
  type: string;
  status?: string;
}

export interface XStateChildCardReader {
  read(cardId: string): XStateChildCard | null;
}

export interface XStateChildActivationOptions {
  projectRoot: string;
  cards: XStateChildCardReader;
  providerTurn: ProviderTurnPort;
  admission?: AdmissionPort;
  reviewerProviderTurn?: ProviderTurnPort;
  goalStatusPort?: GoalCardStatusPort;
  terminalStatusPort?: TerminalCardStatusPort;
}

export function createXStateChildActivation(options: XStateChildActivationOptions): ChildActivationPort {
  const activation = new XStateChildActivation(options);
  return activation;
}

class XStateChildActivation implements ChildActivationPort {
  constructor(private readonly options: XStateChildActivationOptions) {}

  async startChild(cardId: string): Promise<ChildActivationOutcome> {
    const card = this.options.cards.read(cardId);
    if (!card) return { status: 'blocked', statusText: `Cannot activate missing child card '${cardId}'.` };
    if (card.type === 'project' || card.type === 'goal') return this.startGoal(card);
    return this.startTerminal(card);
  }

  private async startGoal(card: XStateChildCard): Promise<ChildActivationOutcome> {
    const runner = new GoalCardRunnerController(this.options.projectRoot, card.id, this.options.providerTurn, this, {
      admission: this.options.admission,
      reviewerProviderTurn: this.options.reviewerProviderTurn,
      statusPort: this.options.goalStatusPort,
      publicStatus: normalizePublicStatus(card.status),
    });
    return runner.start({
      inputId: `activate-goal:${card.id}`,
      role: 'planner',
      sessionId: plannerActorId(card.id),
      systemPrompt: `Plan and execute goal card '${card.id}'.`,
      contextMessages: [],
      tools: XSTATE_PLANNER_TOOL_DEFINITIONS,
      terminalToolNames: [],
      modelParams: {},
      capabilityRequest: { requiresTools: true },
      episodeContext: { cardId: card.id, cardType: card.type },
    });
  }

  private async startTerminal(card: XStateChildCard): Promise<ChildActivationOutcome> {
    const runner = new TerminalCardRunnerController(
      this.options.projectRoot,
      card.id,
      this.options.providerTurn,
      this.options.admission,
      normalizePublicStatus(card.status),
      this.options.terminalStatusPort,
    );
    const outcome = await runner.start({
      inputId: `activate-terminal:${card.id}`,
      role: 'executor',
      sessionId: executorActorId(card.id),
      systemPrompt: `Execute terminal card '${card.id}'.`,
      contextMessages: [],
      tools: XSTATE_PROCESS_TOOL_DEFINITIONS,
      terminalToolNames: [],
      modelParams: {},
      capabilityRequest: { requiresTools: false },
      episodeContext: { cardId: card.id, cardType: card.type },
    });
    if (outcome.status === 'needs_verification') return { status: 'blocked', statusText: outcome.statusText };
    return { status: outcome.status, statusText: outcome.statusText };
  }
}

function normalizePublicStatus(status: string | undefined): 'backlog' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' {
  if (status === 'running' || status === 'done' || status === 'failed' || status === 'blocked' || status === 'cancelled') return status;
  return 'backlog';
}
