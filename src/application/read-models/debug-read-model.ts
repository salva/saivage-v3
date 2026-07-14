import type { CardStore, CardStoreRepository } from '../../cards/store-api.js';
import { readRuntimeState } from '../../runtime/state-api.js';
import { runtimeStateSchema } from '../../schemas/index.js';
import type { RuntimeState } from '../../schemas/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import { readAppLogEntries } from '../../persistence/app-log.js';
import type { ApplicationPersistenceHealthProjection } from '../../contracts/index.js';

export type DebugRuntimeReadModel = RuntimeState & { pid: number };
export interface DebugStateReadModel { runtime: DebugRuntimeReadModel | null; cards: Array<Record<string, unknown>>; totalCards: number; persistenceHealth: ApplicationPersistenceHealthProjection; }
export interface DebugJsonlReadModel { errors?: unknown[]; events?: unknown[]; total: number; }

export class DebugReadModelService {
  constructor(private readonly projectRoot: string, private readonly store: CardStore | CardStoreRepository, private readonly persistenceHealth: () => ApplicationPersistenceHealthProjection = () => ({ state: 'healthy' })) {}

  getState(pid = process.pid): DebugStateReadModel {
    const state = readRuntimeState(this.projectRoot);
    const cards = this.store.list();
    const cardIndex = cards.map((c) => ({ id: c.id, type: c.type, parent: c.parent, status: c.status, title: c.title, priority: c.priority, depends_on: c.depends_on }));
    return { runtime: state ? runtimeStateSchema.extend({ pid: runtimeStateSchema.shape.pid }).parse({ ...state, pid }) : null, cards: cardIndex, totalCards: cards.length, persistenceHealth: this.persistenceHealth() };
  }

  getErrors(): DebugJsonlReadModel {
    const errors = readAppLogEntries(this.projectRoot, 'error').map((entry) => entry.data);
    const redactedErrors = errors.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.errors' }));
    return { errors: redactedErrors, total: redactedErrors.length };
  }

  getTimeline(): DebugJsonlReadModel {
    const events = readAppLogEntries(this.projectRoot, 'event').map((entry) => entry.data);
    const redactedEvents = events.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.timeline' }));
    return { events: redactedEvents, total: redactedEvents.length };
  }

}
