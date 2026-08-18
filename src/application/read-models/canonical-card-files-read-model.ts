import type { WorkspaceFilesListResponse } from '../../contracts/index.js';
import type {
  CardService,
  CanonicalCardFileSlot,
} from '../../cards/card-api.js';
import { cardIdSchema, childCardId, MAX_CARD_DEPTH } from '../../schemas/card-id.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import type { WorkspaceFileContentResult, WorkspaceFilesListResult } from './workspace-file-read-model.js';
import { AuthoredRecordNotFoundError } from '../../persistence/authored-record-files.js';
import type { RecordProjection } from '../../persistence/authored-record-files.js';
import { cardArtifactSchema, type CardArtifact } from '../../persistence/canonical-card-artifacts.js';
import { projectCardRecordForOutbound, projectCardVersionChangeForOutbound } from './card-outbound.js';

const CARDS_ROOT = '.saivage/cards';
const MAX_FILE_SIZE_BYTES = 1_048_576;

export type CanonicalCardFilesReader = {
  current(cardId: string, filename: string): RecordProjection;
  historical(cardId: string, filename: string, version: number): RecordProjection;
  definition(cardId:string,filename:string):unknown;
} & Pick<CardService, 'getCanonicalCard' | 'getCanonicalCardChildren' | 'getCanonicalCardFilesMetadata' | 'getCanonicalCardFileContent' | 'readCardVersion'>;

type ParsedCardPath =
  | { readonly kind: 'cards-root' }
  | { readonly kind: 'namespace'; readonly cardId: string }
  | { readonly kind: 'children'; readonly cardId: string }
  | { readonly kind: 'artifact'; readonly cardId: string; readonly slot: CanonicalCardFileSlot; readonly version: number | null };

function parseCanonicalCardPath(path: string): ParsedCardPath | null {
  if (path === CARDS_ROOT) return { kind: 'cards-root' };
  if (!path.startsWith(`${CARDS_ROOT}/`)) return null;
  const components = path.slice(CARDS_ROOT.length + 1).split('/');
  if (components[0] !== 'project') return null;
  let cardId = 'project';
  let index = 1;
  let depth = 0;
  while (index + 1 < components.length && components[index] === 'children' && /^[a-z]+$/.test(components[index + 1]!)) {
    if (depth === MAX_CARD_DEPTH) return null;
    cardId = childCardId(cardId, components[index + 1]!);
    depth += 1;
    index += 2;
  }
  if (!cardIdSchema.safeParse(cardId).success) return null;
  if (index === components.length) return { kind: 'namespace', cardId };
  if (index + 1 === components.length && components[index] === 'children') return { kind: 'children', cardId };
  if (index + 1 === components.length) {
    const cardMatch = /^card\.json(?:\?v=([1-9][0-9]*))?$/.exec(components[index]!);
    if (cardMatch) {
      const version = cardMatch[1] === undefined ? null : Number(cardMatch[1]);
      if (version !== null && !Number.isSafeInteger(version)) return null;
      return { kind: 'artifact', cardId, slot: 'card', version };
    }
    if (/^[a-z][a-z0-9-]{0,63}\.md$/u.test(components[index]!)) return { kind: 'artifact', cardId, slot: components[index] as CanonicalCardFileSlot, version: null };
  }
  return null;
}

function directoryRow(name: string, path: string, modifiedAt: string): WorkspaceFilesListResponse['files'][number] {
  return { name, path, type: 'directory', modifiedAt };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

function projectCardDocument(artifact: CardArtifact): unknown {
  if (artifact.kind === 'card-version') {
    return {
      format_version: 1,
      kind: artifact.kind,
      entry_id: artifact.entry_id,
      card_id: artifact.card_id,
      version: artifact.version,
      published_at: artifact.committed_at,
      card: projectCardRecordForOutbound(artifact.card),
      change: projectCardVersionChangeForOutbound(artifact.change),
    };
  }
  return {
    format_version: 1,
    kind: artifact.kind,
    entry_id: artifact.entry_id,
    card_id: artifact.card_id,
    version: artifact.version,
    published_at: artifact.committed_at,
    prior_card_version: artifact.prior_card_version,
    final_card: projectCardRecordForOutbound(artifact.final_card),
    change: projectCardVersionChangeForOutbound(artifact.change),
  };
}

function cardContent(path: string, artifact: CardArtifact): WorkspaceFileContentResult {
  const content = `${JSON.stringify(sortJson(projectCardDocument(artifact)), null, 2)}\n`;
  return { body: { path, size: Buffer.byteLength(content), contentType: 'application/json', content, redacted: true, sensitivity: 'sensitive-redacted', version: artifact.version, modifiedAt: artifact.committed_at } };
}

export class CanonicalCardFilesReadModel {
  constructor(private readonly cards: () => CanonicalCardFilesReader) {}

  syntheticCardsRow(): WorkspaceFilesListResponse['files'][number] | null {
    const project = this.cards().getCanonicalCard('project');
    return project.kind === 'card-not-found'
      ? null
      : directoryRow('cards', CARDS_ROOT, project.value.card.updated_at);
  }

  list(path: string): WorkspaceFilesListResult {
    const parsed = parseCanonicalCardPath(path);
    if (!parsed) return { statusCode: 404, body: { error: 'Path not found', path } };
    if (parsed.kind === 'artifact') return { statusCode: 400, body: { error: 'Path is not a directory', path } };
    if (parsed.kind === 'cards-root') {
      const project = this.cards().getCanonicalCard('project');
      return project.kind === 'card-not-found'
        ? { statusCode: 404, body: { error: 'Path not found', path } }
        : { body: { path, files: [directoryRow('project', `${CARDS_ROOT}/project`, project.value.card.updated_at)] } };
    }
    if (parsed.kind === 'children') {
      const projection = this.cards().getCanonicalCardChildren(parsed.cardId);
      if (projection.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Path not found', path } };
      return {
        body: {
          path,
          files: projection.value.activeChildren.map(({ card }) => {
            const name = card.id.split('-').at(-1)!;
            return directoryRow(name, `${path}/${name}`, card.updated_at);
          }),
        },
      };
    }
    const projection = this.cards().getCanonicalCardFilesMetadata(parsed.cardId);
    if (projection.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Path not found', path } };
    return {
      body: {
        path,
        files: [
          directoryRow('children', `${path}/children`, projection.value.card.card.updated_at),
          ...projection.value.files.map((file) => ({
            name: file.slot === 'card' ? 'card.json' : file.slot,
            path: `${path}/${file.slot === 'card' ? 'card.json' : file.slot}`,
            type: 'file' as const,
            size: file.size,
            modifiedAt: file.modifiedAt,
          })),
        ],
      },
    };
  }

  content(path: string): WorkspaceFileContentResult {
    const parsed = parseCanonicalCardPath(path);
    if (!parsed) return { statusCode: 404, body: { error: 'File not found', path } };
    if (parsed.kind !== 'artifact') return { statusCode: 400, body: { error: 'Path is a directory', path } };
    if (parsed.slot !== 'card') {
      try {
        const record = this.cards().current(parsed.cardId, parsed.slot); const effective = record.artifact.state === 'open' ? record.artifact.draft : record.artifact.accepted; if (!effective) throw new AuthoredRecordNotFoundError();
        const bytes = Buffer.from(effective.content);
        if (bytes.byteLength > MAX_FILE_SIZE_BYTES) return { statusCode: 413, body: { error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`, path, size: bytes.byteLength, maxSize: MAX_FILE_SIZE_BYTES } };
        const content = redactTextForOutbound(effective.content);
        return { body: { path, size: Buffer.byteLength(content), contentType: 'text/markdown', content, redacted: true, sensitivity: 'sensitive-redacted', version: record.headVersion, modifiedAt: record.artifact.state === 'open' ? record.artifact.draft!.updated_at : record.artifact.accepted!.committed_at } };
      } catch (error) {
        if (error instanceof AuthoredRecordNotFoundError) return { statusCode: 404, body: { error: 'File not found', path } };
        throw error;
      }
    }
    if (parsed.version !== null) {
      const historical = this.cards().readCardVersion(parsed.cardId, parsed.version);
      if (historical.kind === 'card-not-found') return { statusCode: 404, body: { error: 'File not found', path } };
      if (historical.kind === 'version-not-found') return { statusCode: 404, body: { error: 'workspace_historical_version_not_found', path, historical: { error: 'historical_version_not_found', resource: 'card', owner_id: parsed.cardId, version: parsed.version } } };
      return cardContent(path, historical.value);
    }
    const result = this.cards().getCanonicalCardFileContent(parsed.cardId, 'card', MAX_FILE_SIZE_BYTES);
    if (result.kind === 'card-not-found' || result.kind === 'slot-not-found') {
      return { statusCode: 404, body: { error: 'File not found', path } };
    }
    if (result.kind === 'too-large') {
      return { statusCode: 413, body: { error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`, path, size: result.size, maxSize: MAX_FILE_SIZE_BYTES } };
    }
    return cardContent(path, cardArtifactSchema.parse(result.value.snapshot.rows[0]));
  }
}
