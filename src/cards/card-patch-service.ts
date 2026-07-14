import { cardRecordSchema, type CardRecord } from '../schemas/index.js';
import { queueNotification } from '../notifications/index.js';
import { now } from '../utils/clock.js';
import {
  applyMutationSync,
  type ApplyMutationDeps,
} from './apply-mutation.js';
import {
  buildUpdatedCard,
  collectChangedFields,
  prunePartialPatch,
  summarizeChangedFields,
  type CardMutationContext,
} from './lifecycle.js';
import type { CardStore } from './card-store.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

export type CardPatchHistoryKind = 'update' | 'status' | 'mutate' | 'depends';

export interface CardPatchServiceConfig {
  projectRoot: string;
  deps: () => ApplyMutationDeps;
  read: (id: string) => CardRecord | null;
  childCount: (id: string) => number;
  detectCycles: (id: string, newDependsOn: string[]) => string[];
  notificationStore: CardStore;
  notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class CardPatchService {
  constructor(private readonly config: CardPatchServiceConfig) {}

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void {
    this.config.notifyCard = notifyCard;
  }

  applyPatch(
    id: string,
    changes: Partial<CardRecord>,
    historyKind: CardPatchHistoryKind,
    ctx: CardMutationContext,
  ): CardRecord {
    const existing = this.config.read(id);
    if (!existing) throw new Error(`Card '${id}' not found.`);
    const realChanges = prunePartialPatch(existing, changes);
    if (Object.keys(realChanges).length === 0) return existing;
    const stamp = now();
    const candidate = buildUpdatedCard(existing, realChanges, stamp, {
      childCount: this.config.childCount(existing.id),
    }, ctx);
    if (realChanges.depends_on !== undefined) {
      const cycle = this.config.detectCycles(existing.id, candidate.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const parsed = cardRecordSchema.safeParse(candidate);
    if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
    const changedFields = collectChangedFields(existing, candidate, realChanges);
    const result = applyMutationSync(this.config.deps(), {
      kind: 'persist',
      next: parsed.data,
      historyKind,
      ctx,
      changedFields,
      changeSummary: summarizeChangedFields(changedFields),
    });
    const persisted = deepClone(result.card!);
    if (ctx.reason === 'terminal lifecycle commit') return persisted;
    try {
      const queued = queueNotification(
        this.config.projectRoot,
        { kind: 'card', cardId: persisted.id },
        'card_changed',
        `${persisted.id} updated (${changedFields.join(', ')}) at v${persisted.version_seq}`,
        { actor: ctx.actor, surface: ctx.surface },
        this.config.notificationStore,
        this.config.notifyCard,
      );
      if (!queued.ok) console.warn(`card_patch_notification_delivery_failed ${JSON.stringify(queued.cardDeliveries.filter((delivery) => !delivery.result.ok))}`);
    } catch {
      // Notification enqueue is best-effort; never break the mutation.
    }
    return persisted;
  }
}
