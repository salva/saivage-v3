import type { AgentRole } from '../../schemas/index.js';
import type { RecordProjection } from '../../persistence/authored-record-files.js';
type AuthoredRecordReader = { record(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection };
import type { AuthoredRecordSlot, RecordVersionArtifact } from '../../persistence/canonical-record-artifacts.js';

export type RecordSlotFormat = RecordVersionArtifact['format'];

export interface RecordSlotDefinition {
  filename: string;
  slot: AuthoredRecordSlot;
  writers: readonly AgentRole[];
  format: RecordSlotFormat;
  schema: string;
}

const RECORD_SLOT_DEFINITIONS: readonly RecordSlotDefinition[] = [
  { filename: 'brief.md', slot: 'brief', writers: ['analyst', 'planner'], format: 'markdown', schema: 'record.brief.markdown.v1' },
  { filename: 'status.md', slot: 'status', writers: ['planner', 'executor'], format: 'markdown', schema: 'record.status.markdown.v1' },
  { filename: 'review.md', slot: 'review', writers: ['reviewer'], format: 'markdown', schema: 'record.review.markdown.v1' },
] as const;

const byFilename = new Map(RECORD_SLOT_DEFINITIONS.map((definition) => [definition.filename, definition]));

export function recordSlotDefinitionForFilename(filename: string): RecordSlotDefinition {
  const definition = byFilename.get(filename); if (!definition) throw new Error(`Unsupported record slot '${filename}'.`); return definition;
}
export function recordSlotDefinitions(): readonly RecordSlotDefinition[] { return RECORD_SLOT_DEFINITIONS; }
export function latestClosedRecordSlot(reader: AuthoredRecordReader, input: { cardId: string; filename: string }): RecordProjection { return reader.record(input.cardId, input.filename, 'latest'); }
export function concreteRecordSlot(reader: AuthoredRecordReader, input: { cardId: string; filename: string; version: number }): RecordProjection { return reader.record(input.cardId, input.filename, input.version); }
