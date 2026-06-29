import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { AgentRole } from '../../tools/tool-catalog.js';

export type RecordSlotVersionStatus = 'open' | 'closed' | 'discarded';

export interface RecordSlotVersionEntry {
  status: RecordSlotVersionStatus;
  opened_at?: string;
  closed_at?: string;
  committed_at?: string;
  discarded_at?: string;
  reason?: string;
  writer?: AgentRole;
  size?: number;
  format?: RecordSlotFormat;
  schema?: string;
  cardVersionSeq?: number;
  globalSeq?: number;
  url?: string;
}

export type RecordSlotFormat = 'markdown' | 'json';

export interface RecordSlotDefinition {
  filename: string;
  slot: string;
  writers: readonly AgentRole[];
  format: RecordSlotFormat;
  schema: string;
  exposed: boolean;
}

export interface ClosedRecordSlotMetadata {
  url: string;
  cardId: string;
  filename: string;
  slot: string;
  version: number;
  writer: AgentRole;
  committed_at: string;
  size: number;
  format: RecordSlotFormat;
  schema: string;
  cardVersionSeq: number;
  globalSeq: number;
}

export interface RecordSlotIndex {
  slot: string;
  latest: number | null;
  open: number | null;
  versions: Record<string, RecordSlotVersionEntry>;
}

export interface RecordUrlParts {
  filename: string;
  slot: string;
  cardId: string;
  version: number;
}

export interface OpenRecordSlot extends RecordUrlParts {
  absolutePath: string;
  relativePath: string;
  recordUrl: string;
}

export const RECORD_OUTPUTS_RELATIVE_DIR = '.saivage/outputs/cards';

export const RECORD_SLOT_DEFINITIONS: readonly RecordSlotDefinition[] = [
  { filename: 'brief.md', slot: 'brief', writers: ['analyst', 'planner'], format: 'markdown', schema: 'record.brief.markdown.v1', exposed: true },
  { filename: 'status.md', slot: 'status', writers: ['planner', 'executor'], format: 'markdown', schema: 'record.status.markdown.v1', exposed: true },
  { filename: 'review.md', slot: 'review', writers: ['reviewer'], format: 'markdown', schema: 'record.review.markdown.v1', exposed: true },
  { filename: 'card.json', slot: 'card', writers: [], format: 'json', schema: 'record.card.json.v1', exposed: false },
] as const;

const RECORD_SLOT_DEFINITION_BY_FILENAME = new Map(RECORD_SLOT_DEFINITIONS.map((definition) => [definition.filename, definition]));
const GLOBAL_INDEX_FILENAME = 'index.json';

export function slotFromFilename(filename: string): string {
  const clean = basename(filename);
  const ext = extname(clean);
  const slot = ext ? clean.slice(0, -ext.length) : clean;
  if (!slot || slot === '.' || slot.includes('/')) throw new Error(`Invalid record filename '${filename}'.`);
  return slot;
}

export function recordSlotDefinitionForFilename(filename: string): RecordSlotDefinition {
  const clean = basename(filename);
  const definition = RECORD_SLOT_DEFINITION_BY_FILENAME.get(clean);
  if (!definition) throw new Error(`Unsupported record slot '${clean}'.`);
  return definition;
}

export function exposedRecordSlotDefinitionForFilename(filename: string): RecordSlotDefinition {
  const definition = recordSlotDefinitionForFilename(filename);
  if (!definition.exposed) throw new Error(`Record slot '${definition.filename}' is internal and cannot be read through record:// URLs.`);
  return definition;
}

export function recordSlotDir(projectRoot: string, cardId: string, slot: string): string {
  return join(projectRoot, RECORD_OUTPUTS_RELATIVE_DIR, cardId, slot);
}

export function recordPath(projectRoot: string, cardId: string, slot: string, version: number, filename: string): { absolutePath: string; relativePath: string } {
  const relativePath = `${RECORD_OUTPUTS_RELATIVE_DIR}/${cardId}/${slot}/${version}${extname(filename) || '.md'}`;
  return { absolutePath: join(projectRoot, relativePath), relativePath };
}

export function normalizeRecordUrl(input: { filename: string; cardId: string; version: number }): string {
  return `record://${basename(input.filename)}?card=${encodeURIComponent(input.cardId)}&v=${input.version}`;
}

export function readRecordSlotIndex(projectRoot: string, cardId: string, slot: string): RecordSlotIndex {
  const path = join(recordSlotDir(projectRoot, cardId, slot), 'index.json');
  if (!existsSync(path)) return { slot, latest: null, open: null, versions: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RecordSlotIndex;
  if (parsed.slot !== slot) throw new Error(`Record slot index mismatch for '${cardId}/${slot}'.`);
  return parsed;
}

export function writeRecordSlotIndex(projectRoot: string, cardId: string, index: RecordSlotIndex): void {
  const dir = recordSlotDir(projectRoot, cardId, index.slot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export function openRecordSlot(projectRoot: string, input: { cardId: string; filename: string }): OpenRecordSlot {
  const filename = basename(input.filename);
  const slot = recordSlotDefinitionForFilename(filename).slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  let version = index.open;
  if (version === null) {
    version = nextUnusedVersion(index);
    index.open = version;
    index.versions[String(version)] = { status: 'open', opened_at: new Date().toISOString() };
    writeRecordSlotIndex(projectRoot, input.cardId, index);
  }
  const path = recordPath(projectRoot, input.cardId, slot, version, filename);
  mkdirSync(recordSlotDir(projectRoot, input.cardId, slot), { recursive: true });
  return { filename, slot, cardId: input.cardId, version, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version }) };
}

export function latestClosedRecordSlot(projectRoot: string, input: { cardId: string; filename: string }): OpenRecordSlot {
  const filename = basename(input.filename);
  const slot = recordSlotDefinitionForFilename(filename).slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.latest === null) throw new Error(`No closed record exists for '${input.cardId}/${slot}'.`);
  const path = recordPath(projectRoot, input.cardId, slot, index.latest, filename);
  return { filename, slot, cardId: input.cardId, version: index.latest, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version: index.latest }) };
}

export function concreteRecordSlot(projectRoot: string, input: { cardId: string; filename: string; version: number }): OpenRecordSlot {
  const filename = basename(input.filename);
  const slot = recordSlotDefinitionForFilename(filename).slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  const entry = index.versions[String(input.version)];
  if (!entry) throw new Error(`Record '${input.cardId}/${slot}/${input.version}' does not exist.`);
  const path = recordPath(projectRoot, input.cardId, slot, input.version, filename);
  return { filename, slot, cardId: input.cardId, version: input.version, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version: input.version }) };
}

export function closeOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string; writer?: AgentRole; cardVersionSeq?: number; globalSeq?: number }): OpenRecordSlot {
  const filename = basename(input.filename);
  const definition = recordSlotDefinitionForFilename(filename);
  const slot = definition.slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.open === null) throw new Error(`Required record 'record://${filename}?card=${input.cardId}&v=next' was not created.`);
  const open = concreteRecordSlot(projectRoot, { cardId: input.cardId, filename, version: index.open });
  if (!recordFileIsNonEmpty(open.absolutePath)) throw new Error(`Required record '${open.recordUrl}' was not created or is empty.`);
  const writer = input.writer ?? singleWriter(definition);
  if (!definition.writers.includes(writer)) throw new Error(`${writer} cannot close record slot '${slot}'.`);
  const size = statSync(open.absolutePath).size;
  const committedAt = new Date().toISOString();
  const cardVersionSeq = input.cardVersionSeq ?? open.version;
  const globalSeq = input.globalSeq ?? nextGlobalRecordSeq(projectRoot);
  index.versions[String(open.version)] = {
    ...index.versions[String(open.version)],
    status: 'closed',
    closed_at: committedAt,
    committed_at: committedAt,
    writer,
    size,
    format: definition.format,
    schema: definition.schema,
    cardVersionSeq,
    globalSeq,
    url: open.recordUrl,
  };
  index.latest = open.version;
  index.open = null;
  writeRecordSlotIndex(projectRoot, input.cardId, index);
  return open;
}

export function discardOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string; reason: string }): OpenRecordSlot | null {
  const filename = basename(input.filename);
  const slot = recordSlotDefinitionForFilename(filename).slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.open === null) return null;
  const version = index.open;
  index.versions[String(version)] = { ...index.versions[String(version)], status: 'discarded', discarded_at: new Date().toISOString(), reason: input.reason };
  index.open = null;
  writeRecordSlotIndex(projectRoot, input.cardId, index);
  const path = recordPath(projectRoot, input.cardId, slot, version, filename);
  return { filename, slot, cardId: input.cardId, version, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version }) };
}

export function readClosedRecordSlotMetadata(projectRoot: string, input: { cardId: string; filename: string; version?: number }): ClosedRecordSlotMetadata {
  const filename = basename(input.filename);
  const definition = exposedRecordSlotDefinitionForFilename(filename);
  const slot = definition.slot;
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  const version = input.version ?? index.latest;
  if (version === null) throw new Error(`No closed record exists for '${input.cardId}/${slot}'.`);
  const entry = index.versions[String(version)];
  if (!entry) throw new Error(`Record '${input.cardId}/${slot}/${version}' does not exist.`);
  if (entry.status !== 'closed') throw new Error(`Record '${input.cardId}/${slot}/${version}' is not closed.`);
  if (!entry.writer || !entry.committed_at || entry.size === undefined || !entry.format || !entry.schema || entry.cardVersionSeq === undefined || entry.globalSeq === undefined || !entry.url) {
    throw new Error(`Closed record '${input.cardId}/${slot}/${version}' is missing required metadata.`);
  }
  return { url: entry.url, cardId: input.cardId, filename, slot, version, writer: entry.writer, committed_at: entry.committed_at, size: entry.size, format: entry.format, schema: entry.schema, cardVersionSeq: entry.cardVersionSeq, globalSeq: entry.globalSeq };
}

export function recordFileIsNonEmpty(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function nextUnusedVersion(index: RecordSlotIndex): number {
  const existing = Object.keys(index.versions).map((key) => Number(key)).filter((value) => Number.isInteger(value));
  return Math.max(index.latest ?? 0, ...existing, 0) + 1;
}

function singleWriter(definition: RecordSlotDefinition): AgentRole {
  if (definition.writers.length === 0) throw new Error(`Record slot '${definition.filename}' has no writer.`);
  return definition.writers[0]!;
}

function nextGlobalRecordSeq(projectRoot: string): number {
  const dir = join(projectRoot, RECORD_OUTPUTS_RELATIVE_DIR);
  const path = join(dir, GLOBAL_INDEX_FILENAME);
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { globalSeq?: unknown } : {};
  const prior = current.globalSeq;
  if (prior !== undefined && (!Number.isInteger(prior) || Number(prior) < 0)) throw new Error('Record global sequence index is invalid.');
  const next = Number(prior ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ globalSeq: next }, null, 2)}\n`, 'utf8');
  return next;
}
