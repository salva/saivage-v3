import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export type RecordSlotVersionStatus = 'open' | 'closed' | 'discarded';

export interface RecordSlotVersionEntry {
  status: RecordSlotVersionStatus;
  opened_at?: string;
  closed_at?: string;
  discarded_at?: string;
  reason?: string;
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

export function slotFromFilename(filename: string): string {
  const clean = basename(filename);
  const ext = extname(clean);
  const slot = ext ? clean.slice(0, -ext.length) : clean;
  if (!slot || slot === '.' || slot.includes('/')) throw new Error(`Invalid record filename '${filename}'.`);
  return slot;
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
  const slot = slotFromFilename(filename);
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
  const slot = slotFromFilename(filename);
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.latest === null) throw new Error(`No closed record exists for '${input.cardId}/${slot}'.`);
  const path = recordPath(projectRoot, input.cardId, slot, index.latest, filename);
  return { filename, slot, cardId: input.cardId, version: index.latest, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version: index.latest }) };
}

export function concreteRecordSlot(projectRoot: string, input: { cardId: string; filename: string; version: number }): OpenRecordSlot {
  const filename = basename(input.filename);
  const slot = slotFromFilename(filename);
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  const entry = index.versions[String(input.version)];
  if (!entry) throw new Error(`Record '${input.cardId}/${slot}/${input.version}' does not exist.`);
  const path = recordPath(projectRoot, input.cardId, slot, input.version, filename);
  return { filename, slot, cardId: input.cardId, version: input.version, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version: input.version }) };
}

export function closeOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string }): OpenRecordSlot {
  const filename = basename(input.filename);
  const slot = slotFromFilename(filename);
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.open === null) throw new Error(`Required record 'record://${filename}?card=${input.cardId}&v=next' was not created.`);
  const open = concreteRecordSlot(projectRoot, { cardId: input.cardId, filename, version: index.open });
  if (!recordFileIsNonEmpty(open.absolutePath)) throw new Error(`Required record '${open.recordUrl}' was not created or is empty.`);
  index.versions[String(open.version)] = { ...index.versions[String(open.version)], status: 'closed', closed_at: new Date().toISOString() };
  index.latest = open.version;
  index.open = null;
  writeRecordSlotIndex(projectRoot, input.cardId, index);
  return open;
}

export function discardOpenRecordSlot(projectRoot: string, input: { cardId: string; filename: string; reason: string }): OpenRecordSlot | null {
  const filename = basename(input.filename);
  const slot = slotFromFilename(filename);
  const index = readRecordSlotIndex(projectRoot, input.cardId, slot);
  if (index.open === null) return null;
  const version = index.open;
  index.versions[String(version)] = { ...index.versions[String(version)], status: 'discarded', discarded_at: new Date().toISOString(), reason: input.reason };
  index.open = null;
  writeRecordSlotIndex(projectRoot, input.cardId, index);
  const path = recordPath(projectRoot, input.cardId, slot, version, filename);
  return { filename, slot, cardId: input.cardId, version, ...path, recordUrl: normalizeRecordUrl({ filename, cardId: input.cardId, version }) };
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
