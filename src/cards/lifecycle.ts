import type { CardRecord, CardStatus, CardType } from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import { PROJECT_CARD_ID } from './project-card.js';

export interface CardMutationContext {
  actor: import('../schemas/index.js').NoteAuthor;
  surface: import('../schemas/index.js').ControlActionSurface;
  reason?: string;
}

export type NewCardInput = Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position' | 'lifecycle'> & { id?: string; lifecycle?: CardLifecycleState };

const CRITICAL_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'parent',
  'depends_on',
  'depth',
  'id',
  'created_at',
  'position',
]);

const ALWAYS_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'artifacts',
  'attachments',
  'metrics',
  'duration_ms',
  'started_at',
  'status_text',
  'status_text_updated_at',
  'status_text_author_session_id',
  'latest_self_report',
]);

const FULL_EDIT_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>(['drafting', 'backlog']);

const LIFECYCLE_LOCKED_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'done',
  'failed',
  'blocked',
  'needs_verification',
  'cancelled',
]);

const TERMINAL_LIFECYCLE_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'lifecycle',
]);

const EXPLICIT_LIFECYCLE_WRITE_REASONS: ReadonlySet<string> = new Set([
  'terminal lifecycle commit',
  'terminal lifecycle repair',
]);

const TERMINAL_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
]);

const TERMINAL_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'done',
  'failed',
  'cancelled',
]);

const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'blocked', 'changed', 'cancelled', 'backlog', 'needs_verification'],
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
  needs_verification: ['cancelled'],
};

const TRACKED_FIELDS = [
  'title',
  'description',
  'acceptance',
  'instructions_file',
  'type',
  'subtype',
  'parent',
  'tags',
  'priority',
  'urgency',
  'estimate',
  'depends_on',
  'blocks',
  'related',
  'assigned_to',
  'artifacts',
  'attachments',
  'position',
] as const satisfies ReadonlyArray<keyof CardRecord>;

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isTerminalType(type: CardType): boolean {
  return TERMINAL_TYPES.has(type);
}

export function isTerminalState(state: CardStatus): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

export function validateTransition(from: CardStatus, to: CardStatus): void {
  if (canTransition(from, to)) return;
  const allowed = VALID_TRANSITIONS[from];
  throw new Error(
    `Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${allowed ? allowed.join(', ') : 'none'}.`,
  );
}

export function summarizeChangedFields(changedFields: string[]): string {
  if (changedFields.length === 0) return 'card updated';
  return `${changedFields.join(', ')} updated`;
}

export function prunePartialPatch(
  existing: CardRecord,
  changes: Partial<CardRecord>,
): Partial<CardRecord> {
  const pruned: Partial<CardRecord> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const current = (existing as unknown as Record<string, unknown>)[key];
    if (valuesEqual(current, value)) continue;
    (pruned as Record<string, unknown>)[key] = value;
  }
  return pruned;
}

export interface MutablePatchFacts {
  childCount: number;
}

export function validateMutablePatch(
  existing: CardRecord,
  changes: Partial<CardRecord>,
  facts: MutablePatchFacts,
  ctx?: CardMutationContext,
): number {
  if ((changes as { type?: string }).type === 'plan') {
    throw new Error('Cannot change card type to plan: planning state lives on goal cards.');
  }
  if (changes.type !== undefined && changes.type !== existing.type) {
    if (existing.id === PROJECT_CARD_ID) {
      throw new Error(`Cannot change the canonical project card '${PROJECT_CARD_ID}' to type '${changes.type}'.`);
    }
    if (changes.type === 'project') {
      throw new Error(`Cannot change card '${existing.id}' to type 'project'. The project card must have canonical id '${PROJECT_CARD_ID}'.`);
    }
  }
  const changedKeys = Object.keys(changes);
  const changesLifecycleField = changedKeys.some((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
  const reopensLifecycle = changes.status !== undefined && changes.status !== existing.status && !LIFECYCLE_LOCKED_STATES.has(changes.status);
  const explicitLifecycleWrite = ctx?.surface === 'runtime' && ctx.actor === 'runtime' && !!ctx.reason && EXPLICIT_LIFECYCLE_WRITE_REASONS.has(ctx.reason);
  const explicitStatusTransition =
    (changedKeys.length === 1 || (changedKeys.length === 2 && changedKeys.includes('lifecycle'))) &&
    changes.status !== undefined &&
    ctx?.surface === 'runtime' &&
    ctx.actor === 'runtime' &&
    typeof ctx.reason === 'string' &&
    ctx.reason.startsWith('status -> ');

  if (changesLifecycleField && !explicitLifecycleWrite && !explicitStatusTransition) {
    const fields = changedKeys.filter((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
    throw new Error(
      `Fields ${fields.join(', ')} are lifecycle-owned and can only be changed by terminal commit, explicit terminal repair, or setStatus transition paths.`,
    );
  }

  if (LIFECYCLE_LOCKED_STATES.has(existing.status) && changesLifecycleField && !reopensLifecycle && !explicitLifecycleWrite && !explicitStatusTransition) {
    const fields = changedKeys.filter((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
    throw new Error(
      `Card '${existing.id}' is in status '${existing.status}'. Fields ${fields.join(', ')} are lifecycle-owned and can only be changed by terminal commit or explicit admin repair paths. Reopen the card before ordinary edits.`,
    );
  }

  if (isTerminalState(existing.status)) {
    for (const key of changedKeys) {
      if ((explicitLifecycleWrite || explicitStatusTransition) && TERMINAL_LIFECYCLE_FIELDS.has(key)) continue;
      if (key !== 'status' && !ALWAYS_ALLOWED_FIELDS.has(key)) {
        throw new Error(
          `Card '${existing.id}' is in status '${existing.status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`,
        );
      }
    }
  } else if (!FULL_EDIT_STATES.has(existing.status)) {
    for (const key of changedKeys) {
      if (CRITICAL_FIELDS.has(key)) {
        throw new Error(
          `Field '${key}' cannot be changed on a card in status '${existing.status}'. Cards in this state allow editing: status, title, description, priority, urgency, tags, and other non-structural fields.`,
        );
      }
    }
  }
  if (changes.type !== undefined && changes.type !== existing.type && isTerminalType(changes.type as CardType)) {
    if (facts.childCount > 0) {
      throw new Error(
        `Cannot change type of card '${existing.id}' to '${changes.type}' because it has ${facts.childCount} child(ren). Terminal cards cannot have children.`,
      );
    }
  }
  if (changes.parent !== undefined && changes.parent !== existing.parent) {
    throw new Error("Field 'parent' cannot be changed via update/mutateCard; card reparenting is not supported.");
  }
  return existing.depth;
}

export function buildUpdatedCard(
  existing: CardRecord,
  changes: Partial<CardRecord>,
  stamp: string,
  facts: MutablePatchFacts,
  ctx?: CardMutationContext,
): CardRecord {
  const newDepth = validateMutablePatch(existing, changes, facts, ctx);
  const newDependsOn =
    changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;
  return {
    ...existing,
    ...changes,
    id: existing.id,
    created_at: existing.created_at,
    created_by: existing.created_by,
    updated_at: stamp,
    depth: newDepth,
    depends_on: newDependsOn,
    blocks: existing.blocks,
    version_seq: existing.version_seq + 1,
  };
}

export function collectChangedFields(
  existing: CardRecord,
  candidate: CardRecord,
  changes: Partial<CardRecord>,
): string[] {
  const changedFields: string[] = [];
  for (const f of TRACKED_FIELDS) {
    if (changes[f] !== undefined && !valuesEqual(existing[f], candidate[f])) {
      changedFields.push(f);
    }
  }
  for (const k of Object.keys(changes)) {
    if (!changedFields.includes(k)) changedFields.push(k);
  }
  return changedFields;
}

export interface BuildNewCardParams {
  input: NewCardInput;
  id: string;
  depth: number;
  position: number;
  timestamp: string;
}

export function assertCanCreateCard(input: NewCardInput): void {
  if ((input as { type: string }).type === 'plan') {
    throw new Error('Plan cards are no longer created. Planning state lives on goal cards.');
  }
  if (input.type === 'project' && input.parent !== null) {
    throw new Error(`Project card '${PROJECT_CARD_ID}' must be the root card and cannot have parent '${input.parent}'.`);
  }
}

export function normalizeNewCardId(
  type: CardType,
  explicitId: string | undefined,
  generateId: () => string,
): string {
  if (type === 'project') return PROJECT_CARD_ID;
  return explicitId ?? generateId();
}

export function buildNewCard({ input, id, depth, position, timestamp }: BuildNewCardParams): CardRecord {
  const lifecycle = input.lifecycle ?? ({ status: input.status, result: null, error: null, completed_at: null } as CardLifecycleState);
  if (input.status !== lifecycle.status) throw new Error(`New card status '${input.status}' must match lifecycle.status '${lifecycle.status}'.`);
  return {
    id,
    type: input.type,
    parent: input.parent,
    depth,
    position,
    title: input.title,
    description: input.description,
    status: input.status,
    subtype: input.subtype ?? null,
    instructions_file: input.instructions_file ?? null,
    tags: input.tags,
    priority: input.priority,
    urgency: input.urgency,
    created_by: input.created_by,
    created_at: timestamp,
    updated_at: timestamp,
    assigned_to: input.assigned_to ?? null,
    depends_on: input.depends_on,
    blocks: [],
    related: input.related,
    acceptance: input.acceptance,
    lifecycle,
    metrics: input.metrics ?? null,
    artifacts: input.artifacts,
    attachments: input.attachments,
    estimate: input.estimate ?? null,
    started_at: input.started_at ?? null,
    duration_ms: input.duration_ms ?? null,
    status_text: input.status_text ?? null,
    status_text_updated_at: input.status_text_updated_at ?? null,
    status_text_author_session_id: input.status_text_author_session_id ?? null,
    latest_self_report: input.latest_self_report ?? null,
    retries: input.retries,
    version_seq: 1,
  };
}
