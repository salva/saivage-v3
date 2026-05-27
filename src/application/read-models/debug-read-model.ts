import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardStore } from '../../cards/index.js';
import { readFreezeManifest, readRuntimeState } from '../../runtime/index.js';
import { redactForOutbound } from '../../redaction/index.js';

export interface DebugStateReadModel { runtime: (Record<string, unknown> & { pid: number }) | null; cards: Array<Record<string, unknown>>; totalCards: number; }
export interface DebugJsonlReadModel { errors?: unknown[]; events?: unknown[]; total: number; }

export class DebugReadModelService {
  private readonly store: CardStore;
  constructor(private readonly projectRoot: string) { this.store = new CardStore(projectRoot); }

  getState(pid = process.pid): DebugStateReadModel {
    const state = readRuntimeState(this.projectRoot);
    if (state && state.status === 'frozen') {
      const manifest = readFreezeManifest(this.projectRoot);
      if (manifest) state.frozen_reason = manifest.reason;
    }
    const cards = this.store.list();
    const cardIndex = cards.map((c) => ({ id: c.id, type: c.type, parent: c.parent, status: c.status, title: c.title, priority: c.priority, depends_on: c.depends_on, blocks: c.blocks }));
    return { runtime: state ? { ...state, pid } : null, cards: cardIndex, totalCards: cards.length };
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
