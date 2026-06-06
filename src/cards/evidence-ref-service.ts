import { cardRecordSchema, type ArtifactRef, type AttachmentRef, type CardRecord } from '../schemas/index.js';
import { queueNotification } from '../notifications/index.js';
import { now } from '../utils/clock.js';
import {
  applyMutationWithOwnedLockSync,
  type ApplyMutationDeps,
  type CardHistoryAppendedPayload,
} from './apply-mutation.js';
import {
  buildUpdatedCard,
  collectChangedFields,
  summarizeChangedFields,
  type CardMutationContext,
} from './lifecycle.js';
import type { ProjectLock } from '../persistence/index.js';
import type { CardStore } from './card-store.js';

export type NewArtifactRef = Omit<ArtifactRef, 'id' | 'card_id' | 'created_at'> & { created_at?: string };
export type NewAttachmentRef = Omit<AttachmentRef, 'id' | 'card_id' | 'created_at'> & { created_at?: string };

export interface AppendEvidenceRefsResult {
  card: CardRecord;
  artifacts: ArtifactRef[];
  attachments: AttachmentRef[];
}

export interface EvidenceRefServiceConfig {
  projectRoot: string;
  projectLock: ProjectLock;
  deps: () => ApplyMutationDeps;
  read: (id: string) => CardRecord | null;
  get: (id: string) => CardRecord | null;
  childCount: (id: string) => number;
  emitHistoryAppended: (event: CardHistoryAppendedPayload) => void;
  notificationStore?: CardStore;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextEvidenceSeq(cardId: string, prefix: 'art' | 'att', existingIds: string[]): number {
  const pattern = new RegExp(`^${prefix}-${cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  return existingIds
    .map((id) => {
      const match = id.match(pattern);
      return match ? parseInt(match[1], 10) : 0;
    })
    .reduce((max, seq) => Math.max(max, seq), 0) + 1;
}

export class EvidenceRefService {
  constructor(private readonly config: EvidenceRefServiceConfig) {}

  appendEvidenceRefs(
    id: string,
    refs: { artifacts?: NewArtifactRef[]; attachments?: NewAttachmentRef[] },
    ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'append evidence refs' },
  ): AppendEvidenceRefsResult {
    const artifactInputs = refs.artifacts ?? [];
    const attachmentInputs = refs.attachments ?? [];
    if (artifactInputs.length === 0 && attachmentInputs.length === 0) {
      const card = this.config.read(id);
      if (!card) throw new Error(`Card '${id}' not found.`);
      return { card, artifacts: [], attachments: [] };
    }

    const events: CardHistoryAppendedPayload[] = [];
    let result: AppendEvidenceRefsResult | null = null;
    this.config.projectLock.withLockSync((handle) => {
      this.config.projectLock.assertOwns(handle);
      const existing = this.config.get(id);
      if (!existing) throw new Error(`Card '${id}' not found.`);

      const stamp = now();
      let artifactSeq = nextEvidenceSeq(id, 'art', existing.artifacts.map((artifact) => artifact.id));
      let attachmentSeq = nextEvidenceSeq(id, 'att', existing.attachments.map((attachment) => attachment.id));
      const artifacts = artifactInputs.map((artifact): ArtifactRef => ({
        ...artifact,
        id: `art-${id}-${artifactSeq++}`,
        card_id: id,
        created_at: artifact.created_at ?? stamp,
      }));
      const attachments = attachmentInputs.map((attachment): AttachmentRef => ({
        ...attachment,
        id: `att-${id}-${attachmentSeq++}`,
        card_id: id,
        created_at: attachment.created_at ?? stamp,
      }));
      const changes: Partial<CardRecord> = {
        ...(artifacts.length > 0 ? { artifacts: [...existing.artifacts, ...artifacts] } : {}),
        ...(attachments.length > 0 ? { attachments: [...existing.attachments, ...attachments] } : {}),
      };
      const candidate = buildUpdatedCard(existing, changes, stamp, {
        childCount: this.config.childCount(existing.id),
      }, ctx);
      const parsed = cardRecordSchema.safeParse(candidate);
      if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
      const changedFields = collectChangedFields(existing, candidate, changes);
      const outcome = applyMutationWithOwnedLockSync(this.config.deps(), handle, {
        kind: 'persist',
        next: parsed.data,
        historyKind: 'mutate',
        ctx,
        changedFields,
        changeSummary: summarizeChangedFields(changedFields),
      });
      if (outcome.event !== null) events.push(outcome.event);
      result = { card: deepClone(outcome.card!), artifacts, attachments };
    });
    for (const event of events) this.config.emitHistoryAppended(event);
    const persisted = result!;
    try {
      queueNotification(
        this.config.projectRoot,
        { kind: 'card', cardId: persisted.card.id },
        'card_changed',
        `${persisted.card.id} updated (evidence refs) at v${persisted.card.version_seq}`,
        { actor: ctx.actor, surface: ctx.surface },
        this.config.notificationStore,
      );
    } catch {
      // Notification enqueue is best-effort; never break the mutation.
    }
    return persisted;
  }
}
