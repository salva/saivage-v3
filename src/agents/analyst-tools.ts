import { join } from 'node:path';
import { CardStore } from '../utils/card-store.js';
import {
  appendNote,
  getNotes,
  deleteAllNotes,
} from '../utils/notes.js';
import {
  getDiaryEntries,
  deleteDiary,
} from '../utils/diary.js';
import {
  readRuntimeState,
  updateRuntimeState,
} from '../utils/runtime-state.js';
import {
  listProcesses,
  tailOutput,
  killProcess as killProc,
  getProcess,
} from '../utils/process-runner.js';
import type { CardRecord, CardType, CardStatus, NoteKind, NoteAuthor } from '../schemas/types.js';

// ── Exported Types ─────────────────────────────────────────────

export interface ActionPreview {
  type: string; // e.g. 'delete_card', 'abort_goal', 'kill_process', 'restart_goal'
  summary: string; // human-readable summary
  affectedCards: Array<{ id: string; title: string; type: string; status: string }>;
  affectedProcesses: Array<{ id: string; command: string; status: string }>;
  warnings: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  preview?: ActionPreview; // present when destructive action needs confirmation
  error?: string;
}

// ── Context Type ───────────────────────────────────────────────

export interface ToolContext {
  projectRoot: string;
  store?: CardStore;
  sessionId?: string;
}

// ── Helpers ────────────────────────────────────────────────────

function saivageDir(projectRoot: string): string {
  return join(projectRoot, '.saivage');
}

function getStore(ctx: ToolContext): CardStore {
  return ctx.store ?? new CardStore(ctx.projectRoot);
}

function now(): string {
  return new Date().toISOString();
}

function cardSummary(card: CardRecord): { id: string; title: string; type: string; status: string } {
  return { id: card.id, title: card.title, type: card.type, status: card.status };
}

// ── Preview Builders ───────────────────────────────────────────

function buildDeletePreview(
  projectRoot: string,
  store: CardStore,
  id: string,
): ActionPreview {
  const card = store.read(id);
  if (!card) {
    return {
      type: 'delete_card',
      summary: `Delete card '${id}' (card not found — no children to delete).`,
      affectedCards: [],
      affectedProcesses: [],
      warnings: [`Card '${id}' does not exist.`],
    };
  }

  const descendantIds = store.getDescendantIds(id);
  const allAffectedIds = [id, ...descendantIds];
  const affectedCards = allAffectedIds.map((cid) => {
    const c = store.read(cid);
    return c
      ? cardSummary(c)
      : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
  });

  const processes = listProcesses(projectRoot);
  const affectedProcesses = processes
    .filter((p) => allAffectedIds.includes(p.card_id))
    .map((p) => ({ id: p.id, command: p.command, status: p.status }));

  const warnings: string[] = [];
  if (descendantIds.length > 0) {
    warnings.push(`This will permanently delete ${descendantIds.length} descendant card(s).`);
  }
  const runningProcs = affectedProcesses.filter((p) => p.status === 'running');
  if (runningProcs.length > 0) {
    warnings.push(`${runningProcs.length} running process(es) will be orphaned.`);
  }

  return {
    type: 'delete_card',
    summary: `Delete card '${card.title}' (${card.id}) and all descendants (${affectedCards.length} total card(s)).`,
    affectedCards,
    affectedProcesses,
    warnings,
  };
}

function buildAbortPreview(
  projectRoot: string,
  store: CardStore,
  goalId: string,
): ActionPreview {
  const goal = store.read(goalId);
  if (!goal) {
    return {
      type: 'abort_goal',
      summary: `Abort goal '${goalId}' (goal not found).`,
      affectedCards: [],
      affectedProcesses: [],
      warnings: [`Goal card '${goalId}' does not exist.`],
    };
  }

  const descendantIds = store.getDescendantIds(goalId);
  const allAffectedIds = [goalId, ...descendantIds];
  const affectedCards = allAffectedIds.map((cid) => {
    const c = store.read(cid);
    return c
      ? cardSummary(c)
      : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
  });

  const processes = listProcesses(projectRoot);
  const affectedProcesses = processes
    .filter((p) => allAffectedIds.includes(p.card_id))
    .map((p) => ({ id: p.id, command: p.command, status: p.status }));

  const warnings: string[] = [];
  const runningCards = affectedCards.filter((c) => c.status === 'running' || c.status === 'active');
  if (runningCards.length > 0) {
    warnings.push(`${runningCards.length} card(s) are in active/running status and will be cancelled.`);
  }

  return {
    type: 'abort_goal',
    summary: `Abort goal '${goal.title}' (${goal.id}) and all descendants (${affectedCards.length} total card(s)).`,
    affectedCards,
    affectedProcesses,
    warnings,
  };
}

function buildRestartGoalPreview(
  projectRoot: string,
  store: CardStore,
  goalId: string,
): ActionPreview {
  const goal = store.read(goalId);
  if (!goal) {
    return {
      type: 'restart_goal',
      summary: `Restart goal '${goalId}' (goal not found).`,
      affectedCards: [],
      affectedProcesses: [],
      warnings: [`Goal card '${goalId}' does not exist.`],
    };
  }

  const descendantIds = store.getDescendantIds(goalId);
  const allAffectedIds = [goalId, ...descendantIds];
  const affectedCards = allAffectedIds.map((cid) => {
    const c = store.read(cid);
    return c
      ? cardSummary(c)
      : { id: cid, title: '(not found)', type: 'unknown', status: 'unknown' };
  });

  const processes = listProcesses(projectRoot);
  const affectedProcesses = processes
    .filter((p) => allAffectedIds.includes(p.card_id) && p.status === 'running')
    .map((p) => ({ id: p.id, command: p.command, status: p.status }));

  const warnings: string[] = [];
  if (affectedProcesses.length > 0) {
    warnings.push(`${affectedProcesses.length} running process(es) will be killed.`);
  }
  warnings.push('The plan diary for this goal will be cleared.');

  return {
    type: 'restart_goal',
    summary: `Restart goal '${goal.title}' (${goal.id}). Running children will be cancelled, plan diary cleared, goal re-queued.`,
    affectedCards,
    affectedProcesses,
    warnings,
  };
}

function buildKillPreview(
  projectRoot: string,
  _store: CardStore,
  processId: string,
): ActionPreview {
  const proc = getProcess(projectRoot, processId);
  if (!proc) {
    return {
      type: 'kill_process',
      summary: `Kill process '${processId}' (process not found).`,
      affectedCards: [],
      affectedProcesses: [],
      warnings: [`Process '${processId}' does not exist in the registry.`],
    };
  }

  return {
    type: 'kill_process',
    summary: `Kill process '${processId}' (${proc.command}) currently '${proc.status}'.`,
    affectedCards: [],
    affectedProcesses: [{ id: proc.id, command: proc.command, status: proc.status }],
    warnings: proc.status === 'running' ? [] : ['This process is not currently running.'],
  };
}

// ── Tool Implementations ───────────────────────────────────────

// 1. create_card
export async function create_card(
  ctx: ToolContext,
  params: {
    type: CardType;
    parent: string | null;
    title: string;
    description: string;
    status?: CardStatus;
    tags?: string[];
    priority?: number;
    urgency?: 'low' | 'normal' | 'high' | 'critical';
    acceptance?: string;
    depends_on?: string[];
    related?: string[];
    id?: string;
  },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);

    // Validate parent exists
    if (params.parent !== null) {
      const parentCard = store.read(params.parent);
      if (!parentCard) {
        return {
          success: false,
          error: `Parent card '${params.parent}' does not exist.`,
        };
      }
    }

    const card = store.create({
      type: params.type,
      parent: params.parent,
      depth: 0, // computed by store
      title: params.title,
      description: params.description,
      status: params.status ?? 'drafting',
      tags: params.tags ?? [],
      priority: params.priority ?? 0,
      urgency: params.urgency ?? 'normal',
      created_by: 'analyst',
      acceptance: params.acceptance ?? '',
      depends_on: params.depends_on ?? [],
      related: params.related ?? [],
      blocks: [],
      artifacts: [],
      attachments: [],
      retries: 0,
      ...(params.id ? { id: params.id } : {}),
    });

    return { success: true, data: card };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Allowed fields for edit_card ───────────────────────────────

const ALLOWED_EDIT_FIELDS = new Set([
  'title',
  'description',
  'status',
  'tags',
  'priority',
  'urgency',
  'acceptance',
  'depends_on',
  'related',
  'estimate',
  'subtype',
  'assigned_to',
  'result',
  'metrics',
  'started_at',
  'completed_at',
  'duration_ms',
  'error',
]);

// 2. edit_card
export async function edit_card(
  ctx: ToolContext,
  params: { id: string } & Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const card = store.read(params.id);
    if (!card) {
      return { success: false, error: `Card '${params.id}' not found.` };
    }

    // Extract only allowed fields
    const changes: Record<string, unknown> = {};
    const rejected: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      if (key === 'id') continue;
      if (ALLOWED_EDIT_FIELDS.has(key)) {
        changes[key] = value;
      } else {
        rejected.push(key);
      }
    }

    if (Object.keys(changes).length === 0) {
      return {
        success: false,
        error: `No allowed fields to update. Rejected fields: ${rejected.join(', ') || '(none)'}`,
      };
    }

    const updated = store.update(params.id, changes as Partial<CardRecord>);
    return { success: true, data: updated };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 3. move_card
export async function move_card(
  ctx: ToolContext,
  params: { id: string; newParent: string | null },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const card = store.read(params.id);
    if (!card) {
      return { success: false, error: `Card '${params.id}' not found.` };
    }

    // Prevent moving a card under itself or its own descendants
    if (params.newParent !== null) {
      if (params.newParent === params.id) {
        return { success: false, error: 'Cannot set a card as its own parent.' };
      }
      const descendants = store.getDescendantIds(params.id);
      if (descendants.includes(params.newParent)) {
        return {
          success: false,
          error: `Cannot move card under its own descendant '${params.newParent}'.`,
        };
      }
    }

    const updated = store.update(params.id, { parent: params.newParent });
    return { success: true, data: updated };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 4. delete_card
export async function delete_card(
  ctx: ToolContext,
  params: { id: string; confirmed?: boolean },
): Promise<ToolResult> {
  const store = getStore(ctx);

  if (params.confirmed !== true) {
    const preview = buildDeletePreview(ctx.projectRoot, store, params.id);
    return { success: true, preview };
  }

  try {
    const card = store.read(params.id);
    if (!card) {
      return { success: false, error: `Card '${params.id}' not found.` };
    }

    // Delete children recursively (bottom-up)
    const descendantIds = store.getDescendantIds(params.id);
    // Sort by depth descending (deepest first) so children are deleted before parents
    const allIds = [params.id, ...descendantIds];
    const cards = allIds
      .map((id) => store.read(id))
      .filter((c): c is CardRecord => c !== null)
      .sort((a, b) => b.depth - a.depth);

    const sd = saivageDir(ctx.projectRoot);
    for (const c of cards) {
      // Delete notes
      try { deleteAllNotes(sd, c.id); } catch { /* best effort */ }
      // Delete diary if plan card
      if (c.type === 'plan') {
        try { deleteDiary(sd, c.id); } catch { /* best effort */ }
      }
      // Delete the card
      store.delete(c.id);
    }

    return { success: true, data: { deleted: cards.map((c) => c.id) } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 5. add_note
export async function add_note(
  ctx: ToolContext,
  params: {
    cardId: string;
    content: string;
    kind?: NoteKind;
    author?: NoteAuthor;
  },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const card = store.read(params.cardId);
    if (!card) {
      return { success: false, error: `Card '${params.cardId}' not found.` };
    }

    const note = appendNote(saivageDir(ctx.projectRoot), params.cardId, {
      author: params.author ?? 'analyst',
      content: params.content,
      kind: params.kind ?? 'comment',
    });

    return { success: true, data: note };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 6. list_cards
export async function list_cards(
  ctx: ToolContext,
  params: {
    status?: CardStatus | CardStatus[];
    type?: CardType | CardType[];
    parent?: string;
    tag?: string;
  },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    let cards = store.list();

    if (params.status) {
      const statuses = Array.isArray(params.status) ? params.status : [params.status];
      cards = cards.filter((c) => statuses.includes(c.status));
    }
    if (params.type) {
      const types = Array.isArray(params.type) ? params.type : [params.type];
      cards = cards.filter((c) => types.includes(c.type));
    }
    if (params.parent !== undefined) {
      if (params.parent === null) {
        cards = cards.filter((c) => c.parent === null);
      } else {
        const children = store.listChildren(params.parent);
        cards = cards.filter((c) => children.includes(c.id));
      }
    }
    const filterTag = params.tag;
    if (filterTag) {
      cards = cards.filter((c) => c.tags.includes(filterTag));
    }

    const summaries = cards.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      status: c.status,
      priority: c.priority,
      parent: c.parent,
      tags: c.tags,
    }));

    return { success: true, data: summaries };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 7. get_card
export async function get_card(
  ctx: ToolContext,
  params: { id: string },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const card = store.read(params.id);
    if (!card) {
      return { success: false, error: `Card '${params.id}' not found.` };
    }

    const notes = getNotes(saivageDir(ctx.projectRoot), params.id);
    const childrenIds = store.listChildren(params.id);
    const children = childrenIds
      .map((cid) => store.read(cid))
      .filter((c): c is CardRecord => c !== null)
      .map(cardSummary);

    return {
      success: true,
      data: {
        ...card,
        notes,
        children,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Tree Node Type ─────────────────────────────────────────────

interface TreeNode {
  id: string;
  type: string;
  title: string;
  status: string;
  children: TreeNode[];
}

// ── Tree Builder ────────────────────────────────────────────────

function buildNode(store: CardStore, id: string): TreeNode | null {
  const card = store.read(id);
  if (!card) return null;

  const childIds = store.listChildren(id);
  const children = childIds
    .map((cid) => buildNode(store, cid))
    .filter((n): n is TreeNode => n !== null);

  return {
    id: card.id,
    type: card.type,
    title: card.title,
    status: card.status,
    children,
  };
}

// 8. get_tree
export async function get_tree(
  ctx: ToolContext,
  params: { rootId?: string },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const rootId = params.rootId ?? 'project';

    const rootCard = store.read(rootId);
    if (!rootCard) {
      return { success: false, error: `Root card '${rootId}' not found.` };
    }

    const tree = buildNode(store, rootId);
    if (!tree) {
      return { success: false, error: `Failed to build tree from '${rootId}'.` };
    }

    return { success: true, data: tree };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 9. get_plan_diary
export async function get_plan_diary(
  ctx: ToolContext,
  params: { goalId: string },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const planCardId = `plan-${params.goalId}`;

    // Verify the plan card exists
    const planCard = store.read(planCardId);
    if (!planCard) {
      return { success: false, error: `Plan card '${planCardId}' not found for goal '${params.goalId}'.` };
    }

    const entries = getDiaryEntries(saivageDir(ctx.projectRoot), planCardId);
    return { success: true, data: entries };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 10. get_card_output
export async function get_card_output(
  ctx: ToolContext,
  params: {
    cardId: string;
    lines?: number;
    processId?: string;
  },
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const card = store.read(params.cardId);
    if (!card) {
      return { success: false, error: `Card '${params.cardId}' not found.` };
    }

    const targetProcessId = params.processId;
    const numLines = params.lines ?? 50;

    if (targetProcessId) {
      // Return output for a specific process
      const proc = getProcess(ctx.projectRoot, targetProcessId);
      if (!proc) {
        return { success: false, error: `Process '${targetProcessId}' not found.` };
      }
      if (proc.card_id !== params.cardId) {
        return {
          success: false,
          error: `Process '${targetProcessId}' is not associated with card '${params.cardId}'.`,
        };
      }

      const output = tailOutput(ctx.projectRoot, targetProcessId, numLines);
      return {
        success: true,
        data: {
          process: { id: proc.id, command: proc.command, status: proc.status, pid: proc.pid },
          output,
        },
      };
    }

    // List all processes for the card with status and tail
    const processes = listProcesses(ctx.projectRoot, { cardId: params.cardId });
    const processDetails = processes.map((proc) => {
      const output = tailOutput(ctx.projectRoot, proc.id, numLines);
      return {
        id: proc.id,
        command: proc.command,
        status: proc.status,
        pid: proc.pid,
        started_at: proc.started_at,
        completed_at: proc.completed_at,
        exit_code: proc.exit_code,
        output,
      };
    });

    return { success: true, data: processDetails };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 11. get_status
export async function get_status(
  ctx: ToolContext,
  _params: Record<string, never>,
): Promise<ToolResult> {
  try {
    const store = getStore(ctx);
    const runtimeState = readRuntimeState(ctx.projectRoot);
    const allCards = store.list();

    const done = allCards.filter((c) => c.status === 'done').length;
    const failed = allCards.filter((c) => c.status === 'failed').length;
    const blocked = allCards.filter((c) => c.status === 'blocked').length;

    const processes = listProcesses(ctx.projectRoot);
    const runningProcesses = processes.filter((p) => p.status === 'running');

    // Get ready queue (cards in backlog/active with satisfied deps)
    const backlogCards = allCards.filter((c) => c.status === 'backlog' || c.status === 'active');
    const readyQueue = backlogCards.filter((c) => {
      if (c.depends_on.length === 0) return true;
      return c.depends_on.every((depId) => {
        const dep = allCards.find((cc) => cc.id === depId);
        return dep && dep.status === 'done';
      });
    });

    return {
      success: true,
      data: {
        runtime: runtimeState,
        queue: readyQueue.map((c) => c.id),
        runningProcesses: runningProcesses.length,
        counts: { done, failed, blocked, total: allCards.length },
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 12. pause_runtime
export async function pause_runtime(
  ctx: ToolContext,
  _params: Record<string, never>,
): Promise<ToolResult> {
  try {
    const state = updateRuntimeState(ctx.projectRoot, {
      status: 'paused',
      paused: true,
      paused_at: now(),
    });
    return { success: true, data: { status: state.status, paused: state.paused } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 13. resume_runtime
export async function resume_runtime(
  ctx: ToolContext,
  _params: Record<string, never>,
): Promise<ToolResult> {
  try {
    const state = updateRuntimeState(ctx.projectRoot, {
      status: 'idle',
      paused: false,
      paused_at: null,
    });
    return { success: true, data: { status: state.status, paused: state.paused } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 14. abort_goal
export async function abort_goal(
  ctx: ToolContext,
  params: { goalId: string; confirmed?: boolean },
): Promise<ToolResult> {
  const store = getStore(ctx);

  if (params.confirmed !== true) {
    const preview = buildAbortPreview(ctx.projectRoot, store, params.goalId);
    return { success: true, preview };
  }

  try {
    const goal = store.read(params.goalId);
    if (!goal) {
      return { success: false, error: `Goal '${params.goalId}' not found.` };
    }

    // Cancel the goal and all descendants
    const descendantIds = store.getDescendantIds(params.goalId);
    const allIds = [params.goalId, ...descendantIds];

    const cancelled: string[] = [];
    for (const id of allIds) {
      try {
        store.setStatus(id, 'cancelled');
        cancelled.push(id);
      } catch { /* best effort */ }
    }

    return { success: true, data: { cancelled } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 15. restart_card
export async function restart_card(
  ctx: ToolContext,
  params: { id: string; confirmed?: boolean },
): Promise<ToolResult> {
  const store = getStore(ctx);

  try {
    const card = store.read(params.id);
    if (!card) {
      return { success: false, error: `Card '${params.id}' not found.` };
    }

    const allowedStatuses: CardStatus[] = ['done', 'failed', 'cancelled'];
    if (!allowedStatuses.includes(card.status)) {
      return {
        success: false,
        error: `Card '${params.id}' has status '${card.status}'. Only done/failed/cancelled cards can be restarted.`,
      };
    }

    if (params.confirmed !== true) {
      const preview: ActionPreview = {
        type: 'restart_card',
        summary: `Restart card '${card.title}' (${card.id}) — will be moved to backlog.`,
        affectedCards: [cardSummary(card)],
        affectedProcesses: [],
        warnings: ['Card result and error will be cleared.'],
      };
      return { success: true, preview };
    }

    const updated = store.update(params.id, {
      status: 'backlog',
      result: null,
      error: null,
      completed_at: null,
    });

    return { success: true, data: updated };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 16. restart_goal
export async function restart_goal(
  ctx: ToolContext,
  params: { goalId: string; confirmed?: boolean },
): Promise<ToolResult> {
  const store = getStore(ctx);

  if (params.confirmed !== true) {
    const preview = buildRestartGoalPreview(ctx.projectRoot, store, params.goalId);
    return { success: true, preview };
  }

  try {
    const goal = store.read(params.goalId);
    if (!goal) {
      return { success: false, error: `Goal '${params.goalId}' not found.` };
    }

    // Cancel all running descendants
    const descendantIds = store.getDescendantIds(params.goalId);
    for (const id of descendantIds) {
      try {
        const child = store.read(id);
        if (child && (child.status === 'running' || child.status === 'active')) {
          store.setStatus(id, 'cancelled');
        }
      } catch { /* best effort */ }
    }

    // Clear the plan diary
    const planCardId = `plan-${params.goalId}`;
    const planCard = store.read(planCardId);
    if (planCard) {
      try { deleteDiary(saivageDir(ctx.projectRoot), planCardId); } catch { /* best effort */ }
    }

    // Reset the goal to backlog
    store.update(params.goalId, {
      status: 'backlog',
      result: null,
      error: null,
      completed_at: null,
    });

    return {
      success: true,
      data: {
        goalId: params.goalId,
        status: 'backlog',
        descendantIds,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 17. kill_process
export async function kill_process(
  ctx: ToolContext,
  params: { processId: string; confirmed?: boolean },
): Promise<ToolResult> {
  if (params.confirmed !== true) {
    const preview = buildKillPreview(ctx.projectRoot, getStore(ctx), params.processId);
    return { success: true, preview };
  }

  try {
    const result = await killProc(ctx.projectRoot, params.processId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
