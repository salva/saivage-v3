import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CardStore } from '../../utils/card-store.js';
import { PlannerControlService } from '../../utils/planner-control.js';
import type {
  CardRecord,
  CardStatus,
  CardType,
  NoteRecord,
  PlannerDispatchRecord,
  PlannerFrameRecord,
  ReviewAssessment,
} from '../../schemas/types.js';
import { getNotes } from '../../utils/notes.js';
import {
  getContainedFileMetadata,
  classifyGeneratedFilePath,
  type SafeFileSensitivity,
} from '../../utils/file-access-security.js';

function saivageDir(projectRoot: string): string {
  return `${projectRoot}/.saivage`;
}

interface GeneratedFileRef {
  path: string;
  source: 'artifact' | 'attachment' | 'result.generated_files' | 'result.artifact_paths';
  artifactId?: string;
  attachmentId?: string;
  artifactType?: CardRecord['artifacts'][number]['type'];
  description?: string;
  retain?: boolean;
  exists?: boolean;
  size?: number;
  modifiedAt?: string;
  previewable: boolean;
  downloadable: boolean;
  blocked: boolean;
  redactedOnly: boolean;
  sensitivity: SafeFileSensitivity;
  availabilityReason?: string;
}

interface VerificationCommandRef {
  command: string;
  process_id: string | null;
  status: string | null;
  exit_code: number | null;
  timed_out: boolean | null;
}

type CardEvidenceState = 'none-recorded' | 'partial' | 'present' | 'missing-files' | 'blocked' | 'redacted' | 'incomplete';

interface CardEvidenceSummary {
  state: CardEvidenceState;
  summary: string;
  hasRecordedEvidence: boolean;
  hasDurableEvidence: boolean;
  missingCount: number;
  blockedCount: number;
  redactedCount: number;
  fileCount: number;
  verificationCount: number;
  toolErrorCount: number;
  parseRecovered: boolean;
}

interface CardEvidence {
  generatedFiles: GeneratedFileRef[];
  verificationCommands: VerificationCommandRef[];
  artifactPaths: string[];
  toolErrors: string[];
  parseFailure?: Record<string, unknown>;
  summary: CardEvidenceSummary;
}

interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase:
    | 'drafting'
    | 'planned'
    | 'ready'
    | 'running'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled';
  explanation: string;
  completionState: 'not-started' | 'in-progress' | 'blocked' | 'failed' | 'cancelled' | 'marked-done';
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  retries: number;
  childCounts: Record<CardStatus, number>;
  hasActiveChildren: boolean;
  hasBlockingChildren: boolean;
  dependencyIds: string[];
  blockedByDependencyIds: string[];
}

interface CardReviewSummary {
  status: 'not-run' | 'passed' | 'failed' | 'incomplete';
  review: ReviewAssessment | null;
  evidenceStatus: 'none' | 'partial' | 'recorded';
  summary: string;
}

interface CardPlanningSummary {
  status: string | null;
  summary: string | null;
  blockedReason: string | null;
  createdCardIds: string[];
  updatedCardIds: string[];
  reviewSummary: string | null;
  hasUnfinishedChildWork: boolean;
  plannerDeclaredDone: boolean;
}

interface DispatchSummaryItem {
  dispatchId: string;
  direction: 'outgoing' | 'incoming';
  parentCardId: string;
  targetCardId: string;
  targetKind: PlannerDispatchRecord['target_kind'];
  status: PlannerDispatchRecord['status'];
  outcome: NonNullable<PlannerDispatchRecord['completion']>['outcome'] | null;
  summary: string | null;
  error: string | null;
  evidenceCardIds: string[];
  completedAt: string | null;
}

interface DispatchSummary {
  outgoing: DispatchSummaryItem[];
  incoming: DispatchSummaryItem[];
}

function normalizeVerificationCommands(result: Record<string, unknown> | null | undefined): VerificationCommandRef[] {
  const commands = result?.['verification_commands'];
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const data = entry as Record<string, unknown>;
      const command = typeof data['command'] === 'string' ? data['command'] : null;
      if (!command) {
        return null;
      }
      return {
        command,
        process_id: typeof data['process_id'] === 'string'
          ? data['process_id']
          : typeof data['processId'] === 'string'
            ? data['processId']
            : typeof data['id'] === 'string'
              ? data['id']
              : null,
        status: typeof data['status'] === 'string' ? data['status'] : null,
        exit_code: typeof data['exit_code'] === 'number'
          ? data['exit_code']
          : typeof data['exitCode'] === 'number'
            ? data['exitCode']
            : null,
        timed_out: typeof data['timed_out'] === 'boolean'
          ? data['timed_out']
          : typeof data['timedOut'] === 'boolean'
            ? data['timedOut']
            : null,
      } satisfies VerificationCommandRef;
    })
    .filter((entry): entry is VerificationCommandRef => entry !== null);
}

function summarizeEvidence(card: CardRecord, evidence: Omit<CardEvidence, 'summary'>): CardEvidenceSummary {
  const generatedFiles = evidence.generatedFiles;
  const verificationCommands = evidence.verificationCommands;
  const missingCount = generatedFiles.filter((file) => file.exists === false && file.blocked !== true).length;
  const blockedCount = generatedFiles.filter((file) => file.blocked === true).length;
  const redactedCount = generatedFiles.filter((file) => file.redactedOnly === true).length;
  const parseRecovered = !!evidence.parseFailure;
  const hasRecordedEvidence = generatedFiles.length > 0
    || verificationCommands.length > 0
    || evidence.toolErrors.length > 0
    || parseRecovered;
  const hasDurableEvidence = card.artifacts.length > 0
    || card.attachments.length > 0
    || (card.result !== null && card.result !== undefined);

  let state: CardEvidenceState = 'present';
  let summary = 'Evidence was recorded for this card.';

  if (!hasRecordedEvidence) {
    state = card.status === 'done' || card.status === 'failed' || card.status === 'blocked'
      ? 'incomplete'
      : 'none-recorded';
    summary = state === 'incomplete'
      ? 'This terminal or blocked card has no operator-facing evidence recorded.'
      : 'No operator-facing evidence is recorded yet.';
  } else if (blockedCount > 0) {
    state = 'blocked';
    summary = `${blockedCount} recorded evidence path${blockedCount === 1 ? ' is' : 's are'} blocked by file-access security.`;
  } else if (missingCount > 0) {
    state = 'missing-files';
    summary = `${missingCount} recorded evidence file${missingCount === 1 ? ' is' : 's are'} missing from the workspace.`;
  } else if (redactedCount > 0) {
    state = 'redacted';
    summary = `${redactedCount} recorded evidence file${redactedCount === 1 ? ' is' : 's are'} available only with redaction.`;
  } else if (parseRecovered || evidence.toolErrors.length > 0) {
    state = 'partial';
    summary = 'Evidence was partially recovered from tool activity or includes tool errors.';
  }

  return {
    state,
    summary,
    hasRecordedEvidence,
    hasDurableEvidence,
    missingCount,
    blockedCount,
    redactedCount,
    fileCount: generatedFiles.length,
    verificationCount: verificationCommands.length,
    toolErrorCount: evidence.toolErrors.length,
    parseRecovered,
  };
}

function buildCardEvidence(projectRoot: string, card: CardRecord): CardEvidence {
  const result = card.result && typeof card.result === 'object'
    ? card.result as Record<string, unknown>
    : null;

  const generatedFiles: GeneratedFileRef[] = [];
  const seenPaths = new Set<string>();
  const artifactPaths: string[] = [];

  function addPath(path: unknown, source: GeneratedFileRef['source'], extras: Omit<GeneratedFileRef, 'path' | 'source' | 'exists' | 'size' | 'modifiedAt' | 'previewable' | 'downloadable' | 'blocked' | 'redactedOnly' | 'sensitivity'> = {}): void {
    const metadata = getContainedFileMetadata(projectRoot, path);
    if (!metadata || seenPaths.has(metadata.path)) {
      return;
    }
    seenPaths.add(metadata.path);
    const classification = classifyGeneratedFilePath(metadata.path);
    const blocked = metadata.blocked === true || classification.blocked;
    generatedFiles.push({
      path: metadata.path,
      source,
      ...extras,
      exists: blocked ? false : metadata.exists,
      size: blocked ? undefined : metadata.size,
      modifiedAt: blocked ? undefined : metadata.modifiedAt,
      availabilityReason: metadata.reason,
      ...classification,
      blocked,
      previewable: blocked ? false : classification.previewable,
      downloadable: blocked ? false : classification.downloadable,
    });
  }

  for (const artifact of card.artifacts) {
    addPath(artifact.path, 'artifact', {
      artifactId: artifact.id,
      artifactType: artifact.type,
      description: artifact.description,
      retain: artifact.retain,
    });
  }

  for (const attachment of card.attachments) {
    addPath(attachment.path, 'attachment', {
      attachmentId: attachment.id,
      description: attachment.description || attachment.title,
    });
  }

  const resultGeneratedFiles = Array.isArray(result?.['generated_files']) ? result?.['generated_files'] as unknown[] : [];
  for (const path of resultGeneratedFiles) {
    addPath(path, 'result.generated_files');
  }

  const resultArtifactPaths = Array.isArray(result?.['artifact_paths']) ? result?.['artifact_paths'] as unknown[] : [];
  for (const path of resultArtifactPaths) {
    const metadata = getContainedFileMetadata(projectRoot, path);
    if (metadata && !metadata.blocked && !artifactPaths.includes(metadata.path)) {
      artifactPaths.push(metadata.path);
    }
    addPath(path, 'result.artifact_paths');
  }

  const toolErrors = Array.isArray(result?.['tool_errors'])
    ? result['tool_errors'].filter((entry): entry is string => typeof entry === 'string')
    : [];

  const parseFailure = result?.['parse_failure'];

  const baseEvidence = {
    generatedFiles,
    verificationCommands: normalizeVerificationCommands(result),
    artifactPaths,
    toolErrors,
    parseFailure: parseFailure && typeof parseFailure === 'object'
      ? parseFailure as Record<string, unknown>
      : undefined,
  };

  return {
    ...baseEvidence,
    summary: summarizeEvidence(card, baseEvidence),
  };
}

function buildChildCounts(children: CardRecord[]): Record<CardStatus, number> {
  return {
    drafting: children.filter((child) => child.status === 'drafting').length,
    backlog: children.filter((child) => child.status === 'backlog').length,
    active: children.filter((child) => child.status === 'active').length,
    running: children.filter((child) => child.status === 'running').length,
    blocked: children.filter((child) => child.status === 'blocked').length,
    done: children.filter((child) => child.status === 'done').length,
    failed: children.filter((child) => child.status === 'failed').length,
    cancelled: children.filter((child) => child.status === 'cancelled').length,
  };
}

function buildLifecycleSummary(card: CardRecord, children: CardRecord[]): CardLifecycleSummary {
  const childCounts = buildChildCounts(children);
  const hasActiveChildren = childCounts.active + childCounts.running > 0;
  const hasBlockingChildren = childCounts.blocked + childCounts.failed > 0;
  const blockedByDependencyIds = card.depends_on;

  const phaseByStatus: Record<CardStatus, CardLifecycleSummary['phase']> = {
    drafting: 'drafting',
    backlog: 'planned',
    active: 'ready',
    running: 'running',
    blocked: 'blocked',
    done: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };

  const completionStateByStatus: Record<CardStatus, CardLifecycleSummary['completionState']> = {
    drafting: 'not-started',
    backlog: 'not-started',
    active: 'in-progress',
    running: 'in-progress',
    blocked: 'blocked',
    done: 'marked-done',
    failed: 'failed',
    cancelled: 'cancelled',
  };

  const explanationByStatus: Record<CardStatus, string> = {
    drafting: 'This card is still being shaped and is not yet dispatchable.',
    backlog: 'This card is planned but has not started.',
    active: 'This card is active and may be waiting for execution or evidence.',
    running: 'This card is currently running and evidence may still be incomplete.',
    blocked: 'This card is blocked and needs blocker resolution before it can complete.',
    done: 'This card is marked done; review and evidence determine whether operators should accept completion.',
    failed: 'This card failed and should not be treated as accepted work.',
    cancelled: 'This card was cancelled and should not be treated as completed work.',
  };

  return {
    status: card.status,
    terminal: card.status === 'done' || card.status === 'failed' || card.status === 'cancelled',
    phase: phaseByStatus[card.status],
    explanation: explanationByStatus[card.status],
    completionState: completionStateByStatus[card.status],
    error: card.error ?? null,
    startedAt: card.started_at ?? null,
    completedAt: card.completed_at ?? null,
    durationMs: card.duration_ms ?? null,
    retries: card.retries,
    childCounts,
    hasActiveChildren,
    hasBlockingChildren,
    dependencyIds: card.depends_on,
    blockedByDependencyIds,
  };
}

function buildReviewSummary(card: CardRecord): CardReviewSummary {
  const result = card.result && typeof card.result === 'object'
    ? card.result as Record<string, unknown>
    : null;
  const rawReview = result?.['review'];
  if (!rawReview || typeof rawReview !== 'object') {
    return {
      status: 'not-run',
      review: null,
      evidenceStatus: 'none',
      summary: 'No reviewer assessment is recorded for this card.',
    };
  }

  const review = rawReview as ReviewAssessment;
  const evidenceStatus = review.evidence_card_ids.length === 0
    ? 'none'
    : review.summary.length === 0
      ? 'partial'
      : 'recorded';

  return {
    status: review.result === 'pass' ? 'passed' : 'failed',
    review,
    evidenceStatus,
    summary: review.summary || 'Reviewer assessment was recorded without a summary.',
  };
}

function buildPlanningSummary(card: CardRecord): CardPlanningSummary | null {
  const result = card.result && typeof card.result === 'object'
    ? card.result as Record<string, unknown>
    : null;
  const rawPlanning = result?.['planning'];
  if (!rawPlanning || typeof rawPlanning !== 'object') {
    return null;
  }

  const planning = rawPlanning as Record<string, unknown>;
  const status = typeof planning['status'] === 'string' ? planning['status'] : null;
  const summary = typeof planning['summary'] === 'string' ? planning['summary'] : null;
  const blockedReason = typeof planning['blocked_reason'] === 'string' ? planning['blocked_reason'] : null;
  const reviewSummary = typeof planning['review_summary'] === 'string' ? planning['review_summary'] : null;
  const createdCardIds = Array.isArray(planning['created_cards'])
    ? planning['created_cards'].flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['id'] === 'string') {
        return [(entry as Record<string, unknown>)['id'] as string];
      }
      return [];
    })
    : [];
  const updatedCardIds = Array.isArray(planning['updated_cards'])
    ? planning['updated_cards'].flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['id'] === 'string') {
        return [(entry as Record<string, unknown>)['id'] as string];
      }
      return [];
    })
    : [];

  // Surface canonical persisted runtime/planner-control semantics when present.
  // Conservative fallback: absent booleans remain false rather than inventing
  // unfinished child work from status, review summary, or queue/card state.
  const plannerDeclaredDone = typeof planning['planner_declared_done'] === 'boolean'
    ? planning['planner_declared_done']
    : false;
  const hasUnfinishedChildWork = typeof planning['has_unfinished_child_work'] === 'boolean'
    ? planning['has_unfinished_child_work']
    : false;

  return {
    status,
    summary,
    blockedReason,
    createdCardIds,
    updatedCardIds,
    reviewSummary,
    hasUnfinishedChildWork,
    plannerDeclaredDone,
  };
}

function summarizeDispatch(dispatch: PlannerDispatchRecord, direction: 'outgoing' | 'incoming'): DispatchSummaryItem {
  return {
    dispatchId: dispatch.dispatch_id,
    direction,
    parentCardId: dispatch.parent_card_id,
    targetCardId: dispatch.target_card_id,
    targetKind: dispatch.target_kind,
    status: dispatch.status,
    outcome: dispatch.completion?.outcome ?? null,
    summary: dispatch.completion?.summary ?? null,
    error: dispatch.completion?.error ?? null,
    evidenceCardIds: dispatch.completion?.evidence_card_ids ?? [],
    completedAt: dispatch.completed_at,
  };
}

function buildDispatchSummary(plannerControl: PlannerControlService, cardId: string): DispatchSummary {
  return {
    outgoing: plannerControl.listDispatches({ parent_card_id: cardId }).map((dispatch) => summarizeDispatch(dispatch, 'outgoing')),
    incoming: plannerControl.listDispatches({ target_card_id: cardId }).map((dispatch) => summarizeDispatch(dispatch, 'incoming')),
  };
}

function enrichCardWithNotes(
  store: CardStore,
  projectRoot: string,
  card: CardRecord,
): CardRecord & { notes: NoteRecord[] } {
  const notes = getNotes(saivageDir(projectRoot), card.id);
  return { ...card, notes };
}

export function registerCardRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  const store = new CardStore(projectRoot);
  const plannerControl = new PlannerControlService(projectRoot);

  const inputDefaults: Omit<CardRecord, 'id' | 'created_at' | 'updated_at'> = {
    type: 'code',
    parent: null,
    depth: 0,
    title: '',
    description: '',
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'user',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    result: null,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    retries: 0,
    assigned_to: null,
  };

  fastify.get('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      let cards = store.list();

      if (query.status) cards = cards.filter((c) => c.status === query.status);
      if (query.type) cards = cards.filter((c) => c.type === query.type);
      if (query.parent) cards = cards.filter((c) => c.parent === query.parent);
      if (query.tag) cards = cards.filter((c) => c.tags.includes(query.tag!));

      const enriched = cards.map((c) => enrichCardWithNotes(store, projectRoot, c));
      return reply.send({ cards: enriched, total: enriched.length });
    } catch (err) {
      request.log.error(err, 'Failed to list cards');
      return reply.status(500).send({
        error: 'Failed to list cards',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const card = store.read(params.id);
      if (!card) {
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const children = store.listChildren(params.id)
        .map((childId) => store.read(childId))
        .filter((c): c is CardRecord => c !== null);

      return reply.send({
        card: enrichCardWithNotes(store, projectRoot, card),
        children,
        ancestorIds: store.getAncestors(params.id),
        evidence: buildCardEvidence(projectRoot, card),
        lifecycle: buildLifecycleSummary(card, children),
        review: buildReviewSummary(card),
        planning: buildPlanningSummary(card),
        dispatches: buildDispatchSummary(plannerControl, params.id),
      });
    } catch (err) {
      request.log.error(err, 'Failed to read card');
      return reply.status(500).send({
        error: 'Failed to read card',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const card = store.create({
        ...inputDefaults,
        type: (body.type as CardType) || inputDefaults.type,
        parent: (body.parent as string | null) ?? inputDefaults.parent,
        title: (body.title as string) || inputDefaults.title,
        description: (body.description as string) || inputDefaults.description,
        status: (body.status as CardStatus) || inputDefaults.status,
        tags: (body.tags as string[]) ?? inputDefaults.tags,
        priority: (body.priority as number) ?? inputDefaults.priority,
        urgency: (body.urgency as CardRecord['urgency']) || inputDefaults.urgency,
        created_by: (body.created_by as CardRecord['created_by']) || inputDefaults.created_by,
        depends_on: (body.depends_on as string[]) ?? inputDefaults.depends_on,
        related: (body.related as string[]) ?? inputDefaults.related,
        acceptance: (body.acceptance as string) || inputDefaults.acceptance,
        result: (body.result as Record<string, unknown>) ?? inputDefaults.result,
        metrics: (body.metrics as Record<string, string | number | boolean | null>) ?? inputDefaults.metrics,
        estimate: (body.estimate as string) ?? inputDefaults.estimate,
        error: (body.error as string) ?? inputDefaults.error,
        retries: (body.retries as number) ?? inputDefaults.retries,
        subtype: (body.subtype as string) ?? inputDefaults.subtype,
        assigned_to: (body.assigned_to as string) ?? inputDefaults.assigned_to,
      });
      return reply.status(201).send({ card: enrichCardWithNotes(store, projectRoot, card) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to create card');
      const clientError = message.includes('validation') || message.includes('Cannot create') || message.includes('Plan cards') || message.includes('Planning state lives')
        || message.includes('not found') || message.includes('cycle');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card creation failed' : 'Failed to create card',
        message,
      });
    }
  });

  fastify.patch('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const body = request.body as Record<string, unknown>;

      const allowedFields = new Set([
        'title', 'description', 'status', 'tags', 'priority',
        'urgency', 'acceptance', 'result', 'metrics', 'depends_on',
        'related', 'estimate', 'error', 'retries', 'parent',
        'assigned_to', 'type', 'subtype',
      ]);

      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (allowedFields.has(key)) changes[key] = value;
      }

      if (Object.keys(changes).length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' });
      }

      const card = store.update(params.id, changes as Partial<CardRecord>);
      return reply.send({ card: enrichCardWithNotes(store, projectRoot, card) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to update card');

      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const clientError = message.includes('validation') || message.includes('Cannot') || message.includes('cycle');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card update failed' : 'Failed to update card',
        message,
      });
    }
  });

  fastify.delete('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      store.delete(params.id);
      return reply.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to delete card');

      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const clientError = message.includes('Cannot delete') || message.includes('children');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card deletion failed' : 'Failed to delete card',
        message,
      });
    }
  });
}
