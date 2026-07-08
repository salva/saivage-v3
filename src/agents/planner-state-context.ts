import type { CardRecord, RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { isUnresolvedRuntimeActivationStatus, readRuntimeState } from '../runtime/state.js';
import { cardBriefForPrompt } from '../runtime/records/card-brief.js';

export type PlannerStateCardStore = Pick<CardStore, 'read' | 'listChildren'>;

export interface PlannerStateContextInput {
  projectRoot: string;
  sessionId: string;
  goalId: string;
  cardStore: PlannerStateCardStore;
  runtimeStateProvider?: () => RuntimeState | null;
}

type CandidateNextAction = {
  kind: 'wait_for_activation' | 'activate_child' | 'emit_result_done' | 'inspect_state' | 'decompose_goal';
  card_id?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

function compactCard(projectRoot: string, card: CardRecord) {
  return {
    id: card.id,
    type: card.type,
    status: card.status,
    title: card.title,
    depends_on: card.depends_on,
    brief: cardBriefForPrompt(projectRoot, card),
    status_text: card.status_text ?? null,
  };
}

function runtimeOpen(runtimeStatus: string, finishedAt?: string | null): boolean {
  if (finishedAt) return false;
  return !['stopped', 'cancelled'].includes(runtimeStatus);
}

function inferNextAction(children: CardRecord[], runtimeState: RuntimeState | null): CandidateNextAction {
  const activeRun = runtimeState?.active_card_run ?? null;
  if (activeRun && runtimeOpen(activeRun.runtime_status)) {
    return {
      kind: 'wait_for_activation',
      card_id: activeRun.card_id,
      confidence: 'high',
      reason: `${activeRun.card_id} already has an active runtime run in ${activeRun.phase}.`,
    };
  }

  const doneIds = new Set(children.filter((child) => child.status === 'done').map((child) => child.id));
  const readyBacklog = children.find(
    (child) =>
      child.status === 'backlog' && child.depends_on.every((dependencyId) => doneIds.has(dependencyId)),
  );
  if (readyBacklog) {
    return {
      kind: 'activate_child',
      card_id: readyBacklog.id,
      confidence: 'medium',
      reason: `${readyBacklog.id} is backlog and its direct dependencies are done or absent.`,
    };
  }

  if (children.length > 0 && children.every((child) => child.status === 'done')) {
    return {
      kind: 'emit_result_done',
      confidence: 'high',
      reason: 'All direct children are done.',
    };
  }

  if (children.some((child) => ['blocked', 'failed'].includes(child.status))) {
    return {
      kind: 'inspect_state',
      confidence: 'low',
      reason: 'One or more direct children are blocked, failed, or need verification.',
    };
  }

  if (children.length === 0) {
    return {
      kind: 'decompose_goal',
      confidence: 'medium',
      reason: 'No direct children exist for this goal yet.',
    };
  }

  return {
    kind: 'inspect_state',
    confidence: 'low',
    reason: 'No deterministic next action was inferred from the current child/runtime state.',
  };
}

export function buildPlannerStateContextText(input: PlannerStateContextInput): string {
  const store = input.cardStore;
  const goal = store.read(input.goalId);
  const children = store
    .listChildren(input.goalId)
    .map((id) => store.read(id))
    .filter((card): card is CardRecord => card !== null)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const runtimeState = input.runtimeStateProvider
    ? input.runtimeStateProvider()
    : readRuntimeState(input.projectRoot);
  const childIds = new Set(children.map((child) => child.id));
  const openRuns = (runtimeState?.runtime_runs ?? [])
    .filter(
      (run) =>
        (run.card_id === input.goalId || childIds.has(run.card_id)) &&
        runtimeOpen(run.runtime_status, run.finished_at),
    )
    .map((run) => ({
      card_id: run.card_id,
      status: run.runtime_status,
      phase: run.phase,
      activated_at: run.started_at ?? null,
    }));
  const unresolvedActivations = (runtimeState?.runtime_activations ?? [])
    .filter(
      (activation) =>
        activation.parent_card_id === input.goalId && isUnresolvedRuntimeActivationStatus(activation.status),
    )
    .map((activation) => ({
      card_id: activation.child_card_id,
      status: activation.status,
      activated_at: activation.requested_at,
    }));
  const state = {
    session_id: input.sessionId,
    goal_id: input.goalId,
    goal: goal ? compactCard(input.projectRoot, goal) : null,
    direct_children: children.map((card) => compactCard(input.projectRoot, card)),
    do_not_recreate: children.map(
      (child) => `${child.title} (exists as ${child.id}, ${child.status})`,
    ),
    runtime: {
      global_status: runtimeState?.status ?? null,
      active_card_run: runtimeState?.active_card_run ?? null,
      unresolved_activations: unresolvedActivations,
      open_runs_for_goal: openRuns,
    },
    candidate_next_action: inferNextAction(children, runtimeState),
  };

  return '## Current Planner State Snapshot\n\n' +
    'This is reconstructed authoritative state for the current goal at activation start. Do not rely on earlier transcript content for current child state.\n\n' +
    '```json\n' +
    `${JSON.stringify(state, null, 2)}\n` +
    '```\n\n' +
    'Rules:\n' +
    '- Existing direct children are authoritative. Do not create a sibling with the same title and type.\n' +
    '- If a needed child already exists, edit/restart/activate it instead of creating a replacement.\n' +
    '- Grandchildren belong to child planners.';
}
