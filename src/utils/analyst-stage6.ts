import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActiveCardRun, AgentSession, CardRecord, CardStatus, RuntimeStatus } from '../schemas/types.js';
import { CardStore } from './card-store.js';
import { appendMessage, findPlannerSessionForCard, getSession, listSessions } from '../agents/session-persistence.js';
import { appendNote, getNotes, markNoteHandled } from './notes.js';
import { writeFileAtomic } from './file-tree.js';
import { sanitizeAnalystPayload, sanitizeAnalystText } from './analyst-sanitization.js';
import { readRuntimeState } from './runtime-state.js';

export const analystIssueSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(['info', 'warning', 'blocker']).optional(),
  evidence_path: z.string().optional(),
}).strict();

export const analystIssuesSchema = z.array(analystIssueSchema);

export type AnalystIssue = z.infer<typeof analystIssueSchema>;

export interface SyntheticPlannerNote {
  id: string;
  target_planner_session_id: string;
  target_goal_card_id: string;
  kind: 'analyst_note' | 'pending_subtree_correction' | 'subtree_changed' | 'reviewer_interrupted';
  affected_card_id: string;
  descendant_card_ids: string[];
  summary: string;
  created_at: string;
}

interface SyntheticQueue { notes: SyntheticPlannerNote[]; }

interface ProjectDirectiveState { lets_dance?: string; project_needs_corrections?: string; }

export type LetsDanceOutcome = 'queued_no_runtime' | 'queued_paused' | 'blocked_project_status' | 'active_run_present' | 'already_pending' | 'wakeup_requested' | 'wakeup_unavailable';
export type LetsDanceDirectiveState = 'recorded' | 'already_pending';
export interface LetsDanceResult {
  directive_recorded: true;
  runtime_status: 'idle' | 'running' | 'paused';
  outcome: LetsDanceOutcome;
  directive_state: LetsDanceDirectiveState;
  project_status?: CardStatus;
  runtime_paused?: boolean;
  active_run_card_id?: string | null;
  wakeup_requested?: boolean;
  expected_next_step: string;
}
export interface LetsDanceWakeupObservation { accepted: boolean; reason: string; }


function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }
function syntheticQueuePath(projectRoot: string): string { return join(saivageDir(projectRoot), 'runtime', 'synthetic-notes.json'); }
function directivesPath(projectRoot: string): string { return join(saivageDir(projectRoot), 'runtime', 'project-directives.json'); }
function now(): string { return new Date().toISOString(); }

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return fallback; }
}

function readSyntheticQueue(projectRoot: string): SyntheticQueue { return readJson<SyntheticQueue>(syntheticQueuePath(projectRoot), { notes: [] }); }
function writeSyntheticQueue(projectRoot: string, queue: SyntheticQueue): void { writeFileAtomic(syntheticQueuePath(projectRoot), JSON.stringify(queue, null, 2) + '\n'); }
export function readProjectDirectives(projectRoot: string): ProjectDirectiveState { return readJson<ProjectDirectiveState>(directivesPath(projectRoot), {}); }
export function peekPendingProjectDirective(projectRoot: string): { kind: 'lets_dance' | 'project_needs_corrections'; recorded_at: string } | null {
  const directives = readProjectDirectives(projectRoot);
  return directives.lets_dance
    ? { kind: 'lets_dance', recorded_at: directives.lets_dance }
    : directives.project_needs_corrections
      ? { kind: 'project_needs_corrections', recorded_at: directives.project_needs_corrections }
      : null;
}
function readDirectives(projectRoot: string): ProjectDirectiveState { return readProjectDirectives(projectRoot); }
function writeDirectives(projectRoot: string, directives: ProjectDirectiveState): void { writeFileAtomic(directivesPath(projectRoot), JSON.stringify(directives, null, 2) + '\n'); }

export function consumePendingProjectDirective(projectRoot: string): { kind: 'lets_dance' | 'project_needs_corrections'; recorded_at: string } | null {
  const directives = readDirectives(projectRoot);
  const consumed = directives.lets_dance
    ? { kind: 'lets_dance' as const, recorded_at: directives.lets_dance }
    : directives.project_needs_corrections
      ? { kind: 'project_needs_corrections' as const, recorded_at: directives.project_needs_corrections }
      : null;
  if (!consumed) return null;
  if (consumed.kind === 'lets_dance') delete directives.lets_dance;
  else delete directives.project_needs_corrections;
  writeDirectives(projectRoot, directives);
  return consumed;
}

export function normalizeAnalystIssues(input: unknown): AnalystIssue[] {
  const parsed = analystIssuesSchema.parse(input);
  return parsed.map((issue) => sanitizeAnalystPayload(issue, 1000) as AnalystIssue);
}

export function runtimeStatusForApi(projectRoot: string): 'idle' | 'running' | 'paused' {
  const state = readRuntimeState(projectRoot);
  if (state?.paused || state?.status === 'paused') return 'paused';
  if (state?.status === 'running') return 'running';
  return 'idle';
}

function expectedNextStepForLetsDance(outcome: LetsDanceOutcome, projectStatus?: CardStatus): string {
  switch (outcome) {
    case 'queued_no_runtime': return 'Directive is durably queued; start or resume a runtime so the next guarded safe tick can consume it.';
    case 'queued_paused': return 'Directive is durably queued; resume the runtime so safeTick can evaluate it.';
    case 'blocked_project_status': return `Directive is durably queued, but project status is '${projectStatus ?? 'missing'}'; set project status to active before expecting work.`;
    case 'active_run_present': return 'Directive is durably queued; an active card run is already present and safeTick will revisit directives after that run clears.';
    case 'already_pending': return 'A lets_dance directive was already pending; wait for a guarded safe tick or inspect runtime events for directive_consumed.';
    case 'wakeup_requested': return 'Runtime wakeup was requested; watch for directive_consumed/runtime events because wakeup does not guarantee planner completion.';
    case 'wakeup_unavailable': return 'Directive is durably queued, but the runtime wakeup hook was unavailable or declined; rely on a later safe tick.';
  }
}

export function withLetsDanceWakeupObservation(result: LetsDanceResult, wakeup: LetsDanceWakeupObservation | null): LetsDanceResult {
  if (!wakeup) return result;
  if (wakeup.accepted) {
    return { ...result, outcome: 'wakeup_requested', wakeup_requested: true, expected_next_step: expectedNextStepForLetsDance('wakeup_requested', result.project_status) };
  }
  return { ...result, outcome: 'wakeup_unavailable', wakeup_requested: false, expected_next_step: expectedNextStepForLetsDance('wakeup_unavailable', result.project_status) };
}

export function recordLetsDanceDirective(projectRoot: string, opts: { runtime_available?: boolean } = {}): LetsDanceResult {
  const directives = readDirectives(projectRoot);
  const alreadyPending = Boolean(directives.lets_dance);
  if (!directives.lets_dance) {
    directives.lets_dance = now();
    appendNote(saivageDir(projectRoot), 'project', { author: 'analyst', kind: 'directive', content: 'lets_dance directive recorded; runtime will activate project card on next safe tick.' });
    writeDirectives(projectRoot, directives);
  }
  const runtime_status = runtimeStatusForApi(projectRoot);
  const state = readRuntimeState(projectRoot);
  const runtime_paused = Boolean(state?.paused || runtime_status === 'paused');
  const active_run_card_id = state?.active_card_run?.card_id ?? null;
  const project_status = new CardStore(projectRoot).read('project')?.status;
  const directive_state: LetsDanceDirectiveState = alreadyPending ? 'already_pending' : 'recorded';
  let outcome: LetsDanceOutcome;
  if (runtime_paused) outcome = 'queued_paused';
  else if (project_status && project_status !== 'active' && project_status !== 'running') outcome = 'blocked_project_status';
  else if (active_run_card_id) outcome = 'active_run_present';
  else if (alreadyPending) outcome = 'already_pending';
  else if (!opts.runtime_available) outcome = 'queued_no_runtime';
  else outcome = 'wakeup_unavailable';
  return {
    directive_recorded: true,
    runtime_status,
    outcome,
    directive_state,
    ...(project_status ? { project_status } : {}),
    runtime_paused,
    active_run_card_id,
    wakeup_requested: false,
    expected_next_step: expectedNextStepForLetsDance(outcome, project_status),
  };
}

export function recordProjectNeedsCorrectionsDirective(projectRoot: string, issues: AnalystIssue[], note?: string): { directive_recorded: true; runtime_status: 'idle' | 'running' | 'paused' } {
  const directives = readDirectives(projectRoot);
  if (!directives.project_needs_corrections) {
    directives.project_needs_corrections = now();
    const body = `project_needs_corrections: ${issues.map((i) => i.summary).join('; ')}${note ? `\n${sanitizeAnalystText(note, 1000)}` : ''}`;
    appendNote(saivageDir(projectRoot), 'project', { author: 'analyst', kind: 'directive', content: body });
    writeDirectives(projectRoot, directives);
  }
  return { directive_recorded: true, runtime_status: runtimeStatusForApi(projectRoot) };
}

function contains(store: CardStore, goalId: string, affectedCardId: string): boolean {
  return goalId === affectedCardId || store.getDescendantIds(goalId).includes(affectedCardId);
}

export function findDeepestContainingPlanner(projectRoot: string, store: CardStore, affectedCardId: string): { session: AgentSession; goalId: string } | null {
  const sessions = listSessions(saivageDir(projectRoot))
    .map((id) => getSession(saivageDir(projectRoot), id))
    .filter((session): session is AgentSession => Boolean(session && session.role === 'planner' && session.goal_card_id));
  const candidates = sessions
    .map((session) => ({ session, goalId: session.goal_card_id as string, card: store.read(session.goal_card_id as string) }))
    .filter((entry): entry is { session: AgentSession; goalId: string; card: CardRecord } => Boolean(entry.card && contains(store, entry.goalId, affectedCardId)))
    .sort((a, b) => b.card.depth - a.card.depth);
  if (candidates[0]) return { session: candidates[0].session, goalId: candidates[0].goalId };
  const ancestors = [affectedCardId, ...store.getAncestors(affectedCardId)];
  for (const id of ancestors) {
    const card = store.read(id);
    if (!card || (card.type !== 'goal' && card.type !== 'project')) continue;
    const session = findPlannerSessionForCard(saivageDir(projectRoot), id);
    if (session) return { session, goalId: id };
  }
  return null;
}

export function queueSyntheticPlannerNote(projectRoot: string, input: Omit<SyntheticPlannerNote, 'id' | 'created_at'>): SyntheticPlannerNote | null {
  const queue = readSyntheticQueue(projectRoot);
  const existing = queue.notes.find((note) => note.target_planner_session_id === input.target_planner_session_id && note.kind === input.kind && note.affected_card_id === input.affected_card_id && note.summary === input.summary);
  if (existing) return existing;
  const note: SyntheticPlannerNote = { ...input, id: `synthetic-${Date.now()}-${queue.notes.length + 1}`, created_at: now() };
  queue.notes.push(note);
  writeSyntheticQueue(projectRoot, queue);
  return note;
}

export function drainSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string): SyntheticPlannerNote[] {
  const queue = readSyntheticQueue(projectRoot);
  const drained = queue.notes.filter((note) => note.target_planner_session_id === plannerSessionId);
  if (drained.length === 0) return [];
  queue.notes = queue.notes.filter((note) => note.target_planner_session_id !== plannerSessionId);
  writeSyntheticQueue(projectRoot, queue);
  return drained;
}

export function discardSubtreeChangedSyntheticNotes(projectRoot: string, affectedCardId: string): number {
  const queue = readSyntheticQueue(projectRoot);
  const before = queue.notes.length;
  queue.notes = queue.notes.filter((note) => !(note.kind === 'subtree_changed' && (note.affected_card_id === affectedCardId || note.descendant_card_ids.includes(affectedCardId))));
  writeSyntheticQueue(projectRoot, queue);
  return before - queue.notes.length;
}

export function injectQueuedSyntheticPlannerNotes(projectRoot: string, plannerSessionId: string): number {
  const notes = drainSyntheticPlannerNotes(projectRoot, plannerSessionId);
  if (notes.length === 0) return 0;
  const lines = ['## Synthetic runtime notes since your last turn', '', ...notes.map((note) => `- ${note.kind} for ${note.affected_card_id}: ${note.summary}${note.descendant_card_ids.length ? ` (descendant_card_ids: ${note.descendant_card_ids.join(', ')})` : ''}`)];
  appendMessage(saivageDir(projectRoot), plannerSessionId, { role: 'user', kind: 'text', content: lines.join('\n') });
  return notes.length;
}

export function markGoalNeedsCorrections(projectRoot: string, originGoalId: string, issues: AnalystIssue[], note?: string): { origin_goal_id: string; notes_recorded_on_goal_ids: string[]; status_transition: { from: CardStatus; to: CardStatus } | null } {
  const store = new CardStore(projectRoot);
  const origin = store.read(originGoalId);
  if (!origin || (origin.type !== 'goal' && origin.type !== 'project')) throw new Error(`Goal '${originGoalId}' not found.`);
  const targets = [originGoalId, ...store.getAncestors(originGoalId)].filter((id) => {
    const card = store.read(id);
    return card?.type === 'goal' || card?.type === 'project';
  });
  const summary = issues.map((issue) => issue.summary).join('; ');
  const content = `pending_subtree_correction from ${originGoalId}: ${summary}${note ? `\n${sanitizeAnalystText(note, 1000)}` : ''}`;
  const recorded: string[] = [];
  for (const target of targets) {
    appendNote(saivageDir(projectRoot), target, { author: 'analyst', kind: 'directive', content });
    recorded.push(target);
    const routed = findDeepestContainingPlanner(projectRoot, store, originGoalId);
    if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: target === originGoalId ? 'pending_subtree_correction' : 'subtree_changed', affected_card_id: originGoalId, descendant_card_ids: target === originGoalId ? [] : [originGoalId], summary });
  }
  let status_transition: { from: CardStatus; to: CardStatus } | null = null;
  if (['done', 'running', 'blocked'].includes(origin.status)) {
    store.update(originGoalId, { status: 'changed' });
    status_transition = { from: origin.status, to: 'changed' };
  }
  return { origin_goal_id: originGoalId, notes_recorded_on_goal_ids: recorded, status_transition };
}

export function markDescendantChanged(projectRoot: string, affectedCardId: string, summary: string): void {
  const store = new CardStore(projectRoot);
  const card = store.read(affectedCardId);
  if (!card) throw new Error(`Card '${affectedCardId}' not found.`);
  if (card.status !== 'changed') store.update(affectedCardId, { status: 'changed' });
  for (const ancestorId of store.getAncestors(affectedCardId)) {
    const ancestor = store.read(ancestorId);
    if (!ancestor || (ancestor.type !== 'goal' && ancestor.type !== 'project')) continue;
    appendNote(saivageDir(projectRoot), ancestorId, { author: 'analyst', kind: 'directive', content: `subtree_changed: ${affectedCardId}: ${sanitizeAnalystText(summary, 1000)}` });
  }
  const routed = findDeepestContainingPlanner(projectRoot, store, affectedCardId);
  if (routed) queueSyntheticPlannerNote(projectRoot, { target_planner_session_id: routed.session.id, target_goal_card_id: routed.goalId, kind: 'subtree_changed', affected_card_id: affectedCardId, descendant_card_ids: [affectedCardId], summary: sanitizeAnalystText(summary, 1000) });
}

/**
 * Notify any running/dormant planner that the analyst has acted on a card it
 * owns, so the planner can resume and integrate the change on its next turn.
 *
 * This is the minimal wakeup signal for two kinds of analyst actions that
 * otherwise would be invisible to the planner until something else happened:
 *   - `add_note` with kind 'directive' or 'escalation' on a goal/project card
 *   - `edit_card` that mutates tracked fields (title, description, acceptance,
 *     depends_on, etc.) on any card under a planner subtree
 *
 * When the affected card is `project` (or any ancestor is `project`) and
 * `recordProjectDirective` is true, also record a `project_needs_corrections`
 * directive so safeTick will re-dispatch the project goal even if no planner
 * session is currently routed to it.
 */
export function notifyPlannerOfAnalystAction(
  projectRoot: string,
  affectedCardId: string,
  summary: string,
  opts: { recordProjectDirective?: boolean; kind?: SyntheticPlannerNote['kind'] } = {},
): void {
  const store = new CardStore(projectRoot);
  const card = store.read(affectedCardId);
  if (!card) return;
  const routed = findDeepestContainingPlanner(projectRoot, store, affectedCardId);
  if (routed) {
    queueSyntheticPlannerNote(projectRoot, {
      target_planner_session_id: routed.session.id,
      target_goal_card_id: routed.goalId,
      kind: opts.kind ?? (affectedCardId === routed.goalId ? 'analyst_note' : 'subtree_changed'),
      affected_card_id: affectedCardId,
      descendant_card_ids: affectedCardId === routed.goalId ? [] : [affectedCardId],
      summary: sanitizeAnalystText(summary, 1000),
    });
  }
  if (opts.recordProjectDirective) {
    const ancestors = store.getAncestors(affectedCardId);
    if (affectedCardId === 'project' || ancestors.includes('project')) {
      const directives = readDirectives(projectRoot);
      if (!directives.project_needs_corrections && !directives.lets_dance) {
        directives.project_needs_corrections = now();
        writeDirectives(projectRoot, directives);
      }
    }
  }
}

export function consumeChangedCardActivation(projectRoot: string, cardId: string): number {
  const store = new CardStore(projectRoot);
  const card = store.read(cardId);
  if (card?.status === 'changed') store.update(cardId, { status: 'running' });
  let removedCardNotes = 0;
  for (const card of store.list()) {
    for (const note of getNotes(saivageDir(projectRoot), card.id)) {
      if (!note.handled && note.content.includes('subtree_changed') && note.content.includes(cardId)) {
        markNoteHandled(saivageDir(projectRoot), card.id, note.id);
        removedCardNotes += 1;
      }
    }
  }
  return removedCardNotes;
}

export interface CardBreadcrumbNode { card_id: string; card_type: string; title: string; status_text?: string; }
export interface DormantPlannerRow { goal_card_id: string; planner_session_id: string; latest_self_report: Record<string, unknown> | null; }
export interface PendingCorrectionRow { card_id: string; status: CardStatus; note_count: number; last_note_at: string | null; }
export interface CardRunsResponse { active_card_run: ActiveCardRun | null; active_breadcrumb: CardBreadcrumbNode[]; dormant_planners: DormantPlannerRow[]; cards_with_pending_corrections: PendingCorrectionRow[]; }

export function buildCardRunsResponse(projectRoot: string): CardRunsResponse {
  const store = new CardStore(projectRoot);
  const state = readRuntimeState(projectRoot);
  const active = state?.active_card_run ?? null;
  const active_breadcrumb = active ? [active.card_id, ...store.getAncestors(active.card_id)].reverse().map((id) => {
    const card = store.read(id)!;
    return { card_id: card.id, card_type: card.type, title: card.title, ...(card.status_text ? { status_text: card.status_text } : {}) };
  }) : [];
  const dormant_planners = listSessions(saivageDir(projectRoot))
    .map((id) => getSession(saivageDir(projectRoot), id))
    .filter((session): session is AgentSession => Boolean(session && session.role === 'planner' && session.goal_card_id && session.id !== active?.planner_session_id))
    .map((session) => {
      const card = store.read(session.goal_card_id as string);
      return { goal_card_id: session.goal_card_id as string, planner_session_id: session.id, latest_self_report: (card?.latest_self_report as Record<string, unknown> | null | undefined) ?? null };
    });
  const cards_with_pending_corrections = store.list().map((card) => {
    const notes = getNotes(saivageDir(projectRoot), card.id).filter((note) => !note.handled && (note.content.includes('pending_subtree_correction') || note.content.includes('subtree_changed') || note.content.includes('project_needs_corrections')));
    return { card, notes };
  }).filter(({ notes }) => notes.length > 0).map(({ card, notes }) => ({ card_id: card.id, status: card.status, note_count: notes.length, last_note_at: notes.map((n) => n.timestamp).sort().at(-1) ?? null }));
  return { active_card_run: active, active_breadcrumb, dormant_planners, cards_with_pending_corrections };
}

export function normalizeRuntimeStatus(status: RuntimeStatus | undefined, paused: boolean | undefined): 'idle' | 'running' | 'paused' {
  if (paused || status === 'paused') return 'paused';
  return status === 'running' ? 'running' : 'idle';
}
