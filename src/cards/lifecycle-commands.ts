import { cardRecordSchema, type CardRecord, type CardStatus } from '../schemas/index.js';
import type { ProjectLock } from '../persistence/index.js';
import { now } from '../utils/clock.js';
import { loadCardStoreState } from '../persistence/card-loader.js';
import { PROJECT_CARD_ID } from './project-card.js';
import type { CardStoreState } from './state.js';
import { applyMutationWithOwnedLockSync, type ApplyMutationDeps } from './apply-mutation.js';
import {
  assertCanCreateCard,
  buildNewCard,
  buildSetStatusLifecycle,
  isTerminalState,
  isTerminalType,
  newCardId,
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';

export interface CardLifecycleCommandsConfig {
  projectRoot: string;
  maxDepth: number;
  projectLock: ProjectLock;
  state: () => CardStoreState;
  setState: (state: CardStoreState) => void;
  deps: () => ApplyMutationDeps;
  read: (id: string) => CardRecord | null;
  validateTransition: (from: CardStatus, to: CardStatus) => void;
  applyPatch: (
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate',
    ctx: CardMutationContext,
  ) => CardRecord;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function generateId(existingIds: string[]): string {
  const prefix = 'card';
  const maxNum = existingIds
    .filter((id) => id.startsWith(prefix + '-'))
    .map((id) => {
      const num = parseInt(id.slice(prefix.length + 1), 10);
      return Number.isNaN(num) ? 0 : num;
    })
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}-${maxNum + 1}`;
}

export class CardLifecycleCommands {
  constructor(private readonly config: CardLifecycleCommandsConfig) {}

  create(input: NewCardInput): CardRecord {
    assertCanCreateCard(input);
    let created: CardRecord | null = null;
    this.config.projectLock.withLockSync((handle) => {
      this.config.projectLock.assertOwns(handle);
      const state = loadCardStoreState(this.config.projectRoot, { maxDepth: this.config.maxDepth });
      this.config.setState(state);
      const nowStamp = now();
      const id = newCardId(input.type, () => generateId(state.allKnownIds()));

      if (state.isReservedId(id)) {
        throw new Error(
          `Cannot create card '${id}': card ids are durable and this id is already reserved by history or archive state.`,
        );
      }

      if (input.type === 'project') {
        const existing = state.list().find((card) => card.type === 'project');
        if (existing) {
          throw new Error(
            `Cannot create duplicate project card. A project card already exists with id '${existing.id}'.`,
          );
        }
      }
      if (input.parent !== null) {
        const parentCard = state.get(input.parent);
        if (!parentCard) {
          if (input.parent !== PROJECT_CARD_ID) throw new Error(`Parent card '${input.parent}' does not exist.`);
        } else {
          if (isTerminalType(parentCard.type)) {
            throw new Error(
              `Cannot create child under terminal card '${input.parent}' (type: ${parentCard.type}). Terminal cards cannot have children.`,
            );
          }
          if (isTerminalState(parentCard.status)) {
            throw new Error(
              `Cannot create child under card '${input.parent}' because it is in status '${parentCard.status}'. Children cannot be created under cards in ${parentCard.status} status.`,
            );
          }
        }
      }
      const parentForDepth = input.parent === null ? null : state.get(input.parent);
      const depth = input.parent === null ? 0 : parentForDepth ? parentForDepth.depth + 1 : 1;
      const position = input.parent === null ? 0 : state.childrenOf(input.parent).length;
      if (depth > this.config.maxDepth) {
        throw new Error(
          `Cannot create card at depth ${depth}. Maximum allowed depth is ${this.config.maxDepth}. Reduce nesting depth by reorganizing the card hierarchy.`,
        );
      }
      const card = buildNewCard({ input, id, depth, position, timestamp: nowStamp });
      const parsed = cardRecordSchema.safeParse(card);
      if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
      if (card.depends_on.length > 0) {
        const cycle = state.detectDependsOnCycle(card.id, card.depends_on);
        if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
      const result = applyMutationWithOwnedLockSync(this.config.deps(), handle, { kind: 'create', card: parsed.data });
      created = result.card;
    });
    return deepClone(created!);
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.config.applyPatch(id, changes, 'update', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'update',
    });
  }

  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord {
    return this.config.applyPatch(id, changes, 'mutate', ctx);
  }

  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.config.applyPatch(id, changes, 'mutate', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'terminal lifecycle commit',
    });
  }

  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.config.applyPatch(id, changes, 'mutate', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'terminal lifecycle repair',
    });
  }

  setStatus(id: string, newStatus: CardStatus): CardRecord {
    const card = this.config.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (newStatus === 'done' || newStatus === 'failed') {
      throw new Error(
        `setStatus does not support '${newStatus}'; use the terminal lifecycle commit path instead.`,
      );
    }
    this.config.validateTransition(card.status, newStatus);
    if (card.status === newStatus) return card;
    const stamp = now();
    const lifecycle = buildSetStatusLifecycle(card, newStatus, stamp);
    return this.config.applyPatch(id, { status: newStatus, lifecycle }, 'status', {
      actor: 'runtime',
      surface: 'runtime',
      reason: `status -> ${newStatus}`,
    });
  }
}
