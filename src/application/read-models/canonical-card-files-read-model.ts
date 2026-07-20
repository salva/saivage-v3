import type { WorkspaceFilesListResponse } from '../../contracts/index.js';
import type {
  CanonicalCardChildrenReadProjection,
  CanonicalCardFileContentRead,
  CanonicalCardFileSlot,
  CanonicalCardFilesMetadataReadProjection,
  CanonicalCardReadProjection,
  CardServiceTargetRead,
} from '../../cards/card-api.js';
import { cardIdSchema, childCardId } from '../../schemas/card-id.js';
import { isRedacted } from '../../workspace/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import type { WorkspaceFileContentResult, WorkspaceFilesListResult } from './workspace-file-read-model.js';

const CARDS_ROOT = '.saivage/cards';
const MAX_FILE_SIZE_BYTES = 1_048_576;
const BINARY_SAMPLE_BYTES = 4096;

export interface CanonicalCardFilesReader {
  record(cardId: string, filename: string, version: number | 'latest' | 'open'): {
    recordUrl: string;
    version: number;
    artifact: { state: string; content: string; committed_at?: string | null };
  };
  getCanonicalCard(id: string): CardServiceTargetRead<CanonicalCardReadProjection>;
  getCanonicalCardChildren(id: string): CardServiceTargetRead<CanonicalCardChildrenReadProjection>;
  getCanonicalCardFilesMetadata(id: string): CardServiceTargetRead<CanonicalCardFilesMetadataReadProjection>;
  getCanonicalCardFileContent(id: string, slot: CanonicalCardFileSlot, maximumBytes: number): CanonicalCardFileContentRead;
}

type ParsedCardPath =
  | { readonly kind: 'cards-root' }
  | { readonly kind: 'namespace'; readonly cardId: string }
  | { readonly kind: 'children'; readonly cardId: string }
  | { readonly kind: 'artifact'; readonly cardId: string; readonly slot: CanonicalCardFileSlot };

function parseCanonicalCardPath(path: string): ParsedCardPath | null {
  if (path === CARDS_ROOT) return { kind: 'cards-root' };
  if (!path.startsWith(`${CARDS_ROOT}/`)) return null;
  const components = path.slice(CARDS_ROOT.length + 1).split('/');
  if (components[0] !== 'project') return null;
  let cardId = 'project';
  let index = 1;
  let depth = 0;
  while (index + 1 < components.length && components[index] === 'children' && /^[a-z]+$/.test(components[index + 1]!)) {
    if (depth === 5) return null;
    cardId = childCardId(cardId, components[index + 1]!);
    depth += 1;
    index += 2;
  }
  if (!cardIdSchema.safeParse(cardId).success) return null;
  if (index === components.length) return { kind: 'namespace', cardId };
  if (index + 1 === components.length && components[index] === 'children') return { kind: 'children', cardId };
  if (index + 1 === components.length) {
    const match = /^(card|brief|status|review)\.jsonl$/.exec(components[index]!);
    if (match) return { kind: 'artifact', cardId, slot: match[1] as CanonicalCardFileSlot };
  }
  return null;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_SAMPLE_BYTES);
  if (length === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index]!;
    if (byte === 0) return true;
    if (!(byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) suspicious += 1;
  }
  return suspicious / length > 0.3;
}

function directoryRow(name: string, path: string, modifiedAt: string): WorkspaceFilesListResponse['files'][number] {
  return { name, path, type: 'directory', modifiedAt };
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
            name: `${file.slot}.jsonl`,
            path: `${path}/${file.slot}.jsonl`,
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
    const result = this.cards().getCanonicalCardFileContent(parsed.cardId, parsed.slot, MAX_FILE_SIZE_BYTES);
    if (result.kind === 'card-not-found' || result.kind === 'slot-not-found') {
      return { statusCode: 404, body: { error: 'File not found', path } };
    }
    if (result.kind === 'too-large') {
      return { statusCode: 413, body: { error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`, path, size: result.size, maxSize: MAX_FILE_SIZE_BYTES } };
    }
    const bytes = result.value.snapshot.bytes;
    if (isBinaryBuffer(bytes)) return { statusCode: 415, body: { error: 'Binary or non-text file cannot be previewed.', path } };
    const redacted = isRedacted(path);
    const content = bytes.toString('utf8');
    return {
      body: {
        path,
        size: result.value.snapshot.size,
        contentType: 'text/plain',
        content: redacted ? redactTextForOutbound(content, 'operator.api', { source: 'workspace-file-read-model' }) : content,
        redacted,
        sensitivity: redacted ? 'sensitive-redacted' : 'normal',
        modifiedAt: result.value.snapshot.modifiedAt,
      },
    };
  }
}
