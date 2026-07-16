import { basename, join } from 'node:path';

import type { AgentRole } from '../schemas/index.js';
import { authoredRecordSlotValues, parseRecordVersionArtifact, type AuthoredRecordSlot, type RecordVersionArtifact } from './canonical-record-artifacts.js';
import { readCardArtifacts } from './card-files.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';

export interface RecordProjection {
  readonly cardId: string;
  readonly filename: string;
  readonly slot: AuthoredRecordSlot;
  readonly version: number;
  readonly recordUrl: string;
  readonly artifact: RecordVersionArtifact;
}

function slotFor(filename: string): AuthoredRecordSlot {
  const slot = basename(filename).replace(/\.(?:md|json)$/u, '');
  if (!authoredRecordSlotValues.includes(slot as AuthoredRecordSlot)) throw new Error(`Unsupported record slot '${filename}'.`);
  return slot as AuthoredRecordSlot;
}

function pathFor(projectRoot: string, cardId: string, slot: AuthoredRecordSlot, version: number): string {
  return join(projectRoot, '.saivage', 'cards', cardId, slot, 'versions', `${version}.json`);
}

function projection(artifact: RecordVersionArtifact): RecordProjection {
  const filename = `${artifact.slot}.md`;
  return Object.freeze({ cardId: artifact.card_id, filename, slot: artifact.slot, version: artifact.version, recordUrl: `record:///${filename}?card=${encodeURIComponent(artifact.card_id)}&v=${artifact.version}`, artifact });
}

function publish(projectRoot: string, artifact: RecordVersionArtifact, publicationTemporaryId?: PublicationTemporaryIdFactory): RecordProjection {
  replaceFile(pathFor(projectRoot, artifact.card_id, artifact.slot, artifact.version), Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`), publicationTemporaryId);
  return projection(artifact);
}

export function readAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection {
  const slot = slotFor(filename);
  const scanned = readCardArtifacts(projectRoot, cardId).records[slot];
  const artifact = version === 'latest' ? scanned.latest : version === 'open' ? scanned.open : scanned.artifacts.find((candidate) => candidate.version === version) ?? null;
  if (!artifact) throw new Error(`Record '${cardId}/${slot}/${String(version)}' does not exist.`);
  return projection(artifact);
}

export function openAuthoredRecord(projectRoot: string, cardId: string, filename: string, publicationTemporaryId?: PublicationTemporaryIdFactory): RecordProjection {
  const slot = slotFor(filename);
  const scanned = readCardArtifacts(projectRoot, cardId).records[slot];
  if (scanned.open) return projection(scanned.open);
  const version = Math.max(0, ...scanned.artifacts.map((artifact) => artifact.version)) + 1;
  const path = pathFor(projectRoot, cardId, slot, version);
  const schema = slot === 'brief' ? 'record.brief.markdown.v1' : slot === 'status' ? 'record.status.markdown.v1' : 'record.review.markdown.v1';
  const artifact = parseRecordVersionArtifact({ kind: 'record-version', format_version: 1, card_id: cardId, slot, version, state: 'open', opened_at: new Date().toISOString(), committed_at: null, closed_at: null, discarded_at: null, reason: null, writer: null, format: 'markdown', schema, card_version_seq: null, content: '' }, path, { cardId, slot, version });
  return publish(projectRoot, artifact, publicationTemporaryId);
}

function requireOpen(projectRoot: string, cardId: string, filename: string, version: number): RecordVersionArtifact {
  const record = readAuthoredRecord(projectRoot, cardId, filename, version).artifact;
  if (record.state !== 'open') throw new Error(`Record '${cardId}/${record.slot}/${version}' is not open.`);
  return record;
}

export function replaceOpenAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, content: string, publicationTemporaryId?: PublicationTemporaryIdFactory): RecordProjection {
  const current = requireOpen(projectRoot, cardId, filename, version);
  const path = pathFor(projectRoot, cardId, current.slot, version);
  return publish(projectRoot, parseRecordVersionArtifact({ ...current, content }, path, { cardId, slot: current.slot, version }), publicationTemporaryId);
}

export function closeAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number, publicationTemporaryId?: PublicationTemporaryIdFactory): RecordProjection {
  const current = requireOpen(projectRoot, cardId, filename, version);
  const stamp = new Date().toISOString();
  const path = pathFor(projectRoot, cardId, current.slot, version);
  return publish(projectRoot, parseRecordVersionArtifact({ ...current, state: 'closed', committed_at: stamp, closed_at: stamp, writer, card_version_seq: cardVersionSeq }, path, { cardId, slot: current.slot, version }), publicationTemporaryId);
}

export function discardAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, reason: string, publicationTemporaryId?: PublicationTemporaryIdFactory): RecordProjection {
  const current = requireOpen(projectRoot, cardId, filename, version);
  const path = pathFor(projectRoot, cardId, current.slot, version);
  return publish(projectRoot, parseRecordVersionArtifact({ ...current, state: 'discarded', discarded_at: new Date().toISOString(), reason }, path, { cardId, slot: current.slot, version }), publicationTemporaryId);
}
