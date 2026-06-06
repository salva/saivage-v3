import { existsSync } from 'node:fs';
import { cardHistoryPath, readHistoryEntriesStrict } from '../persistence/card-loader.js';
import type { CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { valuesEqual } from './value-equality.js';

export interface CardDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CardHistoryReaderConfig {
  projectRoot: string;
  read: (id: string) => CardRecord | null;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class CardHistoryReader {
  constructor(private readonly config: CardHistoryReaderConfig) {}

  listCardHistory(id: string): CardHistoryEntry[] {
    const hp = cardHistoryPath(this.config.projectRoot, id);
    if (!existsSync(hp)) return [];
    return readHistoryEntriesStrict(hp).slice().reverse();
  }

  getCardAt(id: string, versionSeq: number): CardRecord {
    const current = this.config.read(id);
    if (!current) throw new Error(`Card '${id}' not found.`);
    if (versionSeq === current.version_seq) return current;
    const hp = cardHistoryPath(this.config.projectRoot, id);
    if (!existsSync(hp)) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    const entries = readHistoryEntriesStrict(hp);
    const entry = entries.find((e) => e.version_seq === versionSeq);
    if (!entry) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    return deepClone(entry.snapshot);
  }

  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    const from = this.getCardAt(id, fromSeq);
    const to = this.getCardAt(id, toSeq);
    const fields = new Set<keyof CardRecord>([
      ...(Object.keys(from) as Array<keyof CardRecord>),
      ...(Object.keys(to) as Array<keyof CardRecord>),
    ]);
    return Array.from(fields)
      .filter((f) => !valuesEqual(from[f], to[f]))
      .map((f) => ({ field: f as string, before: from[f], after: to[f] }));
  }
}
