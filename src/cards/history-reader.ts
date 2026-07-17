import { readCardArtifacts } from '../persistence/card-files.js';
import type { CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { valuesEqual } from './value-equality.js';

export interface CardDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CardHistoryReaderConfig {
  projectRoot: string;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class CardHistoryReader {
  constructor(private readonly config: CardHistoryReaderConfig) {}

  listCardHistory(id: string): CardHistoryEntry[] {
    const card = readCardArtifacts(this.config.projectRoot, id);
    return [...card.artifacts.flatMap((artifact) => artifact.history ? [artifact.history] : []), ...(card.tombstone ? [card.tombstone.deletion_history] : [])].reverse();
  }

  getCardAt(id: string, versionSeq: number): CardRecord {
    const artifact = readCardArtifacts(this.config.projectRoot, id).artifacts.find((candidate) => candidate.version === versionSeq);
    if (!artifact) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    return deepClone(artifact.card);
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
