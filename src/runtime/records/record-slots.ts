import { basename, extname } from 'node:path';

import type { AgentRole } from '../../schemas/index.js';
import { buildScopedPathUrl } from '../../contracts/scoped-path-url.js';
import type { RecordProjection } from '../../persistence/authored-record-files.js';
type AuthoredRecordReader = { record(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection };
import type { AuthoredRecordSlot, RecordVersionArtifact } from '../../persistence/canonical-record-artifacts.js';

export type RecordSlotVersionStatus = RecordVersionArtifact['state'];
export type RecordSlotFormat = RecordVersionArtifact['format'];

export interface RecordSlotDefinition {
  filename: string;
  slot: AuthoredRecordSlot | 'card';
  writers: readonly AgentRole[];
  format: RecordSlotFormat | 'json';
  schema: string;
  exposed: boolean;
}

export type RecordSlotCloseFailureReason = 'missing_open' | 'empty_open';
export class ExpectedRecordSlotCloseError extends Error {
  constructor(public readonly reason: RecordSlotCloseFailureReason, message: string) { super(message); this.name = 'ExpectedRecordSlotCloseError'; }
}

export const RECORD_SLOT_DEFINITIONS: readonly RecordSlotDefinition[] = [
  { filename: 'brief.md', slot: 'brief', writers: ['analyst', 'planner'], format: 'markdown', schema: 'record.brief.markdown.v1', exposed: true },
  { filename: 'status.md', slot: 'status', writers: ['planner', 'executor'], format: 'markdown', schema: 'record.status.markdown.v1', exposed: true },
  { filename: 'review.md', slot: 'review', writers: ['reviewer'], format: 'markdown', schema: 'record.review.markdown.v1', exposed: true },
  { filename: 'card.json', slot: 'card', writers: [], format: 'json', schema: 'record.card.json.v1', exposed: false },
] as const;

const byFilename = new Map(RECORD_SLOT_DEFINITIONS.map((definition) => [definition.filename, definition]));

export function slotFromFilename(filename: string): string {
  const clean = basename(filename); const ext = extname(clean); return ext ? clean.slice(0, -ext.length) : clean;
}
export function recordSlotDefinitionForFilename(filename: string): RecordSlotDefinition {
  const clean = basename(filename); const definition = byFilename.get(clean); if (!definition) throw new Error(`Unsupported record slot '${clean}'.`); return definition;
}
export function exposedRecordSlotDefinitionForFilename(filename: string): RecordSlotDefinition {
  const definition = recordSlotDefinitionForFilename(filename); if (!definition.exposed) throw new Error(`Record slot '${definition.filename}' is internal and cannot be read through record:/// URLs.`); return definition;
}
export function recordSlotDefinitions(): readonly RecordSlotDefinition[] { return RECORD_SLOT_DEFINITIONS; }
export function normalizeRecordUrl(input: { filename: string; cardId: string; version: number }): string {
  return `${buildScopedPathUrl('record', [basename(input.filename)])}?card=${encodeURIComponent(input.cardId)}&v=${encodeURIComponent(String(input.version))}`;
}
export function latestClosedRecordSlot(reader: AuthoredRecordReader, input: { cardId: string; filename: string }): RecordProjection { return reader.record(input.cardId, input.filename, 'latest'); }
export function concreteRecordSlot(reader: AuthoredRecordReader, input: { cardId: string; filename: string; version: number }): RecordProjection { return reader.record(input.cardId, input.filename, input.version); }
export function recordContentIsNonEmpty(record: RecordProjection): boolean { return record.artifact.content.trim().length > 0; }
