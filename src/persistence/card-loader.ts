import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardHistoryEntrySchema, cardRecordSchema, validatePersistedCardLifecycle } from '../schemas/index.js';
import type { CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { CardStoreState } from '../cards/state.js';
import { CardStoreInvariantError } from '../cards/errors.js';
import { validateCardHistoryInvariant, validateParsedCards } from '../cards/validator.js';
import { allocateGlobalRecordSeq, normalizeRecordUrl, readRecordSlotIndex, recordPath, recordSlotDir, writeRecordSlotIndex, type RecordSlotIndex } from '../runtime/records/record-slots.js';

export interface LoadCardStoreStateOptions {
  maxDepth?: number;
}

export function byIdDir(projectRoot: string): string {
  return cardRecordsRoot(projectRoot);
}

export function historyDir(projectRoot: string): string {
  return cardRecordsRoot(projectRoot);
}

export function cardByIdPath(projectRoot: string, id: string): string {
  const index = readRecordSlotIndex(projectRoot, id, 'card');
  if (index.latest === null) return recordPath(projectRoot, id, 'card', 1, 'card.json').absolutePath;
  return recordPath(projectRoot, id, 'card', index.latest, 'card.json').absolutePath;
}

export function cardHistoryPath(projectRoot: string, id: string): string {
  return join(recordSlotDir(projectRoot, id, 'card'), 'index.json');
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function stripBlocks(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { blocks: _blocks, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function parseCard(raw: unknown, path: string): CardRecord {
  const parsed = cardRecordSchema.safeParse(stripBlocks(raw));
  if (!parsed.success) {
    throw new CardStoreInvariantError(`Card record at '${path}' is invalid: ${parsed.error.message}`);
  }
  try {
    validatePersistedCardLifecycle(parsed.data);
    if (parsed.data.status !== parsed.data.lifecycle.status) {
      throw new Error(`status '${parsed.data.status}' does not match lifecycle.status '${parsed.data.lifecycle.status}'`);
    }
    return parsed.data;
  } catch (err) {
    throw new CardStoreInvariantError(
      `Card record at '${path}' has invalid lifecycle fields: ${(err as Error).message}`,
    );
  }
}

export function cardRecordsRoot(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'outputs', 'cards');
}

export function cardRecordNamespaceDir(projectRoot: string, id: string): string {
  return join(cardRecordsRoot(projectRoot), id);
}

export function cardRecordVersionPath(projectRoot: string, id: string, version: number): string {
  return recordPath(projectRoot, id, 'card', version, 'card.json').absolutePath;
}

export function readHistoryEntriesStrict(indexPath: string): CardHistoryEntry[] {
  if (!existsSync(indexPath)) return [];
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as RecordSlotIndex;
  return Object.entries(index.versions)
    .map(([version, entry]) => ({ version: Number(version), history: entry.history }))
    .filter((entry) => entry.history !== undefined)
    .sort((a, b) => a.version - b.version)
    .map((entry) => {
      const parsed = cardHistoryEntrySchema.safeParse(entry.history);
      if (!parsed.success) throw new CardStoreInvariantError(`Card history in '${indexPath}' version ${entry.version} failed schema validation: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function writeCardRecordVersion(projectRoot: string, card: CardRecord, historyEntry?: CardHistoryEntry): void {
  const filename = 'card.json';
  const slot = 'card';
  const index = readRecordSlotIndex(projectRoot, card.id, slot);
  if (card.version_seq !== nextCardVersion(index)) throw new CardStoreInvariantError(`Card '${card.id}' expected next card.json version ${nextCardVersion(index)}, got ${card.version_seq}.`);
  const path = recordPath(projectRoot, card.id, slot, card.version_seq, filename);
  mkdirSync(recordSlotDir(projectRoot, card.id, slot), { recursive: true });
  writeFileSync(path.absolutePath, JSON.stringify(cardRecordSchema.parse(card), null, 2) + '\n', 'utf-8');
  const committedAt = new Date().toISOString();
  index.latest = card.version_seq;
  index.open = null;
  index.versions[String(card.version_seq)] = {
    status: 'closed',
    closed_at: committedAt,
    committed_at: committedAt,
    size: statSync(path.absolutePath).size,
    format: 'json',
    schema: 'record.card.json.v1',
    cardVersionSeq: card.version_seq,
    globalSeq: allocateGlobalRecordSeq(projectRoot),
    url: normalizeRecordUrl({ filename, cardId: card.id, version: card.version_seq }),
    ...(historyEntry ? { history: historyEntry } : {}),
  };
  writeRecordSlotIndex(projectRoot, card.id, index);
}

export function writeBriefRecordVersion(projectRoot: string, card: CardRecord, content: string, writer: 'analyst' | 'planner' = 'analyst'): void {
  const filename = 'brief.md';
  const slot = 'brief';
  const index = readRecordSlotIndex(projectRoot, card.id, slot);
  const version = nextCardVersion(index);
  const path = recordPath(projectRoot, card.id, slot, version, filename);
  mkdirSync(recordSlotDir(projectRoot, card.id, slot), { recursive: true });
  writeFileSync(path.absolutePath, content, 'utf-8');
  const committedAt = new Date().toISOString();
  index.latest = version;
  index.open = null;
  index.versions[String(version)] = {
    status: 'closed',
    closed_at: committedAt,
    committed_at: committedAt,
    writer,
    size: statSync(path.absolutePath).size,
    format: 'markdown',
    schema: 'record.brief.markdown.v1',
    cardVersionSeq: card.version_seq,
    globalSeq: allocateGlobalRecordSeq(projectRoot),
    url: normalizeRecordUrl({ filename, cardId: card.id, version }),
  };
  writeRecordSlotIndex(projectRoot, card.id, index);
}

function nextCardVersion(index: RecordSlotIndex): number {
  const existing = Object.keys(index.versions).map((key) => Number(key)).filter((value) => Number.isInteger(value));
  return Math.max(index.latest ?? 0, ...existing, 0) + 1;
}

export function loadCardStoreState(projectRoot: string, options: LoadCardStoreStateOptions = {}): CardStoreState {
  const maxDepth = options.maxDepth !== undefined && options.maxDepth > 0 ? options.maxDepth : 5;
  const state = new CardStoreState(maxDepth);
  const dir = cardRecordsRoot(projectRoot);
  if (!existsSync(dir)) return state;
  const cards = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((name) => {
      const cardId = typeof name === 'string' ? name : name.name;
      const index = readRecordSlotIndex(projectRoot, cardId, 'card');
      if (index.latest === null) return null;
      const path = cardRecordVersionPath(projectRoot, cardId, index.latest);
      return parseCard(readJsonFile(path), path);
    })
    .filter((card): card is CardRecord => card !== null);
  const validated = validateParsedCards({ cards, maxDepth });
  for (const card of validated.cardsInDepthOrder) state.upsert(card);
  for (const card of cards) {
    validateCardHistoryInvariant(
      card.id,
      card.version_seq,
      cardHistoryPath(projectRoot, card.id),
      readHistoryEntriesStrict(cardHistoryPath(projectRoot, card.id)),
    );
  }
  const liveIdSet = new Set(cards.map((card) => card.id));
  const archiveDir = join(projectRoot, '.saivage', 'archive', 'cards');
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir)) {
      const id = name.replace(/\.json$/, '');
      if (!liveIdSet.has(id)) state.addReservedId(id);
    }
  }
  return state;
}
