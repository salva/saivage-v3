import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardHistoryEntrySchema, cardRecordSchema, validatePersistedCardLifecycle } from '../schemas/index.js';
import type { CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { lastLineSync } from './index.js';
import { CardStoreState } from '../cards/state.js';
import { CardStoreInvariantError } from '../cards/errors.js';
import { validateCardHistoryInvariant, validateParsedCards } from '../cards/validator.js';

export interface LoadCardStoreStateOptions {
  maxDepth?: number;
}

export function byIdDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'by-id');
}

export function historyDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'history');
}

export function cardByIdPath(projectRoot: string, id: string): string {
  return join(byIdDir(projectRoot), `${id}.json`);
}

export function cardHistoryPath(projectRoot: string, id: string): string {
  return join(historyDir(projectRoot), `${id}.history.jsonl`);
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

function parseHistoryLine(line: string, jsonlPath: string, lineNo: number): CardHistoryEntry {
  let json: unknown;
  try {
    json = JSON.parse(line) as unknown;
  } catch (err) {
    throw new CardStoreInvariantError(
      `Card history at '${jsonlPath}' line ${lineNo} is unparseable JSONL: ${(err as Error).message}`,
    );
  }
  const normalized = json && typeof json === 'object' && !Array.isArray(json)
    ? { ...(json as Record<string, unknown>), snapshot: stripBlocks((json as Record<string, unknown>).snapshot) }
    : json;
  const parsed = cardHistoryEntrySchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CardStoreInvariantError(
      `Card history at '${jsonlPath}' line ${lineNo} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function readHistoryEntriesStrict(jsonlPath: string): CardHistoryEntry[] {
  if (!existsSync(jsonlPath)) return [];
  const raw = readFileSync(jsonlPath, 'utf-8');
  if (raw.length === 0) return [];
  const tail = lastLineSync(jsonlPath);
  if (!tail.endsWithNewline) {
    throw new CardStoreInvariantError(
      `Card history file '${jsonlPath}' ends without a newline (partial last line: ${JSON.stringify(
        tail.partialTail?.slice(0, 80) ?? '',
      )}). Recovery hint: run 'saivage reset' or repair the file by hand.`,
    );
  }
  const entries: CardHistoryEntry[] = [];
  raw.split('\n').forEach((line, index) => {
    if (line !== '') entries.push(parseHistoryLine(line, jsonlPath, index + 1));
  });
  return entries;
}

export function loadCardStoreState(projectRoot: string, options: LoadCardStoreStateOptions = {}): CardStoreState {
  const maxDepth = options.maxDepth !== undefined && options.maxDepth > 0 ? options.maxDepth : 5;
  const state = new CardStoreState(maxDepth);
  const dir = byIdDir(projectRoot);
  if (!existsSync(dir)) return state;
  const cards = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(dir, name);
      return parseCard(readJsonFile(path), path);
    });
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
  const historicDir = historyDir(projectRoot);
  if (existsSync(historicDir)) {
    for (const name of readdirSync(historicDir)) {
      if (!name.endsWith('.history.jsonl')) continue;
      const id = name.slice(0, -'.history.jsonl'.length);
      if (!liveIdSet.has(id)) state.addReservedId(id);
    }
  }
  const archiveDir = join(projectRoot, '.saivage', 'archive', 'cards');
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!liveIdSet.has(id)) state.addReservedId(id);
    }
  }
  return state;
}
