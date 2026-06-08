import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardStore } from '../../cards/store-api.js';
import { readRuntimeState } from '../../runtime/state-api.js';
import { runtimeStateSchema } from '../../schemas/index.js';
import type { RuntimeState } from '../../schemas/index.js';
import { redactForOutbound } from '../../redaction/index.js';

export type DebugRuntimeReadModel = RuntimeState & { pid: number };
export interface DebugStateReadModel { runtime: DebugRuntimeReadModel | null; cards: Array<Record<string, unknown>>; totalCards: number; }
export interface DebugJsonlReadModel { errors?: unknown[]; events?: unknown[]; total: number; }

export class DebugReadModelService {
  constructor(private readonly projectRoot: string, private readonly store: CardStore) {}

  getState(pid = process.pid): DebugStateReadModel {
    const state = readRuntimeState(this.projectRoot);
    const cards = this.store.list();
    const cardIndex = cards.map((c) => ({ id: c.id, type: c.type, parent: c.parent, status: c.status, title: c.title, priority: c.priority, depends_on: c.depends_on }));
    return { runtime: state ? runtimeStateSchema.extend({ pid: runtimeStateSchema.shape.pid }).parse({ ...state, pid }) : null, cards: cardIndex, totalCards: cards.length };
  }

  getErrors(): DebugJsonlReadModel {
    const errors = this.readJsonl(join(this.projectRoot, '.saivage', 'runtime', 'errors.jsonl'));
    const redactedErrors = errors.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.errors' }));
    return { errors: redactedErrors, total: redactedErrors.length };
  }

  getTimeline(): DebugJsonlReadModel {
    const events = this.readJsonl(join(this.projectRoot, '.saivage', 'runtime', 'events.jsonl'));
    const redactedEvents = events.map((entry) => redactForOutbound(entry, 'operator.api', { source: 'debug-read-model.timeline' }));
    return { events: redactedEvents, total: redactedEvents.length };
  }

  private readJsonl(path: string): unknown[] {
    const entries: unknown[] = [];
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      for (const line of raw.split('\n').filter(Boolean)) {
        try { entries.push(JSON.parse(line)); } catch { void 0; }
      }
    }
    return entries;
  }
}
