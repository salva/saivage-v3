import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { buildScopedPathUrl, parseScopedPathUrl } from '../../contracts/scoped-path-url.js';
import type { OperatorApiHandlerResult, WorkspaceFilesListResponse } from '../../contracts/index.js';
import { isReadBlocked, isRedacted, resolveContainedProjectPath, workUrlFromAbsolutePath } from '../../workspace/index.js';
import { redactForOutbound, redactTextForOutbound } from '../../redaction/index.js';
import { SAIVAGE_CARDS_RELATIVE_DIR, SAIVAGE_WORK_RELATIVE_DIR } from '../../persistence/layout.js';
import { CanonicalCardFilesReadModel, type CanonicalCardFilesReader } from './canonical-card-files-read-model.js';
import { AuthoredRecordNotFoundError } from '../../persistence/authored-record-files.js';
import { currentRecordDefinitionForFilename } from '../../records/current-record-definitions.js';
import { cardIdSchema } from '../../schemas/index.js';
import type { ResolvedConfigAuthority } from '../../config/index.js';

const MAX_FILE_SIZE_BYTES = 1_048_576;
const BINARY_SAMPLE_BYTES = 4096;

export type WorkspaceFilesListResult = OperatorApiHandlerResult<'files.list'>;
export type WorkspaceFileContentResult = OperatorApiHandlerResult<'files.content'>;

interface ResolvedRequestPathBase {
  absolutePath: string;
  responsePath: string;
  kind: 'project' | 'work';
  policyRelativePath?: string;
  realTargetProjectRelativePath?: string;
}
type ResolvedRequestPath =
  | ResolvedRequestPathBase & { safe: true; policyRelativePath: string }
  | ResolvedRequestPathBase & { safe: false; reason: string };

type FilesAdmission =
  | { kind: 'generic' }
  | { kind: 'reserved-card' }
  | { kind: 'rejected'; reason: string; responsePath: string; blockedSource?: true };

type RecordContentRequest =
  | { kind: 'valid'; cardId: string; filename: string; version: number | 'latest' }
  | { kind: 'invalid'; error: string };

const CANNOT_RESOLVE_REASON = 'Path cannot be resolved.';
const MAX_CLASSIFIER_SYMLINK_EXPANSIONS = 40;

function isContainedPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isReservedCardPath(candidate: string, lexicalCardRoot: string, realCardRoot: string): boolean {
  return isContainedPath(lexicalCardRoot, candidate) || isContainedPath(realCardRoot, candidate);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_SAMPLE_BYTES);
  if (length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < length; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    const isPrintable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!isPrintable) suspicious += 1;
  }
  return suspicious / length > 0.3;
}

function parseRecordContentRequest(requestedPath: string): RecordContentRequest {
  let parsed: ReturnType<typeof parseScopedPathUrl>;
  try { parsed = parseScopedPathUrl(requestedPath, 'record'); }
  catch { return { kind: 'invalid', error: 'Invalid record URL.' }; }
  if (parsed.hadFragment || parsed.segments.length !== 1 || !parsed.query) return { kind: 'invalid', error: 'Invalid record URL.' };
  for (const key of parsed.query.keys()) if (key !== 'card' && key !== 'v') return { kind: 'invalid', error: 'Invalid record URL.' };
  if (parsed.query.getAll('card').length !== 1 || parsed.query.getAll('v').length > 1) return { kind: 'invalid', error: 'Invalid record URL.' };
  const filename = parsed.segments[0]!;
  try { currentRecordDefinitionForFilename(filename); }
  catch { return { kind: 'invalid', error: 'Invalid record URL.' }; }
  const rawCardId = parsed.query.get('card');
  if (!rawCardId) return { kind: 'invalid', error: 'Record URL requires card.' };
  const parsedCardId = cardIdSchema.safeParse(rawCardId);
  if (!parsedCardId.success) return { kind: 'invalid', error: 'Invalid record URL.' };
  const rawVersion = parsed.query.get('v') ?? 'latest';
  if (rawVersion === 'latest') return { kind: 'valid', cardId: parsedCardId.data, filename, version: 'latest' };
  if (!/^[1-9]\d*$/u.test(rawVersion)) return { kind: 'invalid', error: 'Invalid record version.' };
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 1) return { kind: 'invalid', error: 'Invalid record version.' };
  return { kind: 'valid', cardId: parsedCardId.data, filename, version };
}

export class WorkspaceFileReadModelService {
  private readonly canonicalCards: CanonicalCardFilesReadModel;

  constructor(
    private readonly projectRoot: string,
    private readonly records: () => CanonicalCardFilesReader,
    private readonly configAuthority: ResolvedConfigAuthority,
  ) {
    this.canonicalCards = new CanonicalCardFilesReadModel(records);
  }

  private isSelectedConfig(absolutePath: string): boolean {
    const authorityPath = resolve(this.configAuthority.path);
    return absolutePath === authorityPath || realpathSync(absolutePath) === realpathSync(authorityPath);
  }

  private resolveRequestedPath(requestedPath: string): ResolvedRequestPath {
    if (requestedPath.startsWith('work:///')) {
      let parsed;
      try {
        parsed = parseScopedPathUrl(requestedPath, 'work');
      } catch (err) {
        return { safe: false, absolutePath: '', responsePath: requestedPath, reason: err instanceof Error ? err.message : String(err), kind: 'work' };
      }
      if (parsed.query !== null || parsed.hadFragment || buildScopedPathUrl('work', parsed.segments) !== requestedPath) return { safe: false, absolutePath: '', responsePath: requestedPath, reason: 'Invalid work URL.', kind: 'work' };
      const resolved = resolveContainedProjectPath(this.projectRoot, `${SAIVAGE_WORK_RELATIVE_DIR}/${parsed.segments.join('/')}`);
      if (!resolved.safe) {
        if (!resolved.reason) throw new Error('Unsafe contained path is missing its rejection reason.');
        return { safe: false, absolutePath: resolved.absolutePath, responsePath: requestedPath, reason: resolved.reason, kind: 'work' };
      }
      if (!resolved.relativePath) throw new Error('Safe contained path is missing its project-relative identity.');
      return { safe: true, absolutePath: resolved.absolutePath, responsePath: requestedPath, policyRelativePath: resolved.relativePath, realTargetProjectRelativePath: resolved.realTargetProjectRelativePath, kind: 'work' };
    }
    const resolved = resolveContainedProjectPath(this.projectRoot, requestedPath);
    if (!resolved.safe) {
      if (!resolved.reason) throw new Error('Unsafe contained path is missing its rejection reason.');
      return { safe: false, absolutePath: resolved.absolutePath, responsePath: resolved.relativePath ?? requestedPath, reason: resolved.reason, kind: 'project' };
    }
    if (!resolved.relativePath) throw new Error('Safe contained path is missing its project-relative identity.');
    return { safe: true, absolutePath: resolved.absolutePath, responsePath: resolved.relativePath, policyRelativePath: resolved.relativePath, realTargetProjectRelativePath: resolved.realTargetProjectRelativePath, kind: 'project' };
  }

  private isBlockedPath(path: { policyRelativePath: string; realTargetProjectRelativePath?: string }): boolean {
    return isReadBlocked(path.policyRelativePath)
      || (path.realTargetProjectRelativePath !== undefined && isReadBlocked(path.realTargetProjectRelativePath));
  }

  private isRedactedPath(path: { policyRelativePath: string; realTargetProjectRelativePath?: string }): boolean {
    return isRedacted(path.policyRelativePath)
      || (path.realTargetProjectRelativePath !== undefined && isRedacted(path.realTargetProjectRelativePath));
  }

  private isWorkPath(path: { kind: 'project' | 'work'; policyRelativePath: string; realTargetProjectRelativePath?: string }): boolean {
    const inWorkNamespace = (candidate: string): boolean => candidate === SAIVAGE_WORK_RELATIVE_DIR || candidate.startsWith(`${SAIVAGE_WORK_RELATIVE_DIR}/`);
    return path.kind === 'work'
      || inWorkNamespace(path.policyRelativePath)
      || (path.realTargetProjectRelativePath !== undefined && inWorkNamespace(path.realTargetProjectRelativePath));
  }

  private classifyAllowedNonCardAlias(policyRelativePath: string): 'generic' | 'reserved-card' | 'indeterminate' {
    const lexicalProjectRoot = resolve(this.projectRoot);
    let realProjectRoot: string;
    try {
      realProjectRoot = realpathSync(lexicalProjectRoot);
    } catch {
      return 'indeterminate';
    }

    const lexicalCardRoot = resolve(lexicalProjectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
    const realCardRoot = resolve(realProjectRoot, SAIVAGE_CARDS_RELATIVE_DIR);
    let expandedPath = resolve(lexicalProjectRoot, policyRelativePath);
    const expandedPaths = new Set<string>([expandedPath]);
    const followedLinks = new Set<string>();
    let expansions = 0;

    for (;;) {
      if (isReservedCardPath(expandedPath, lexicalCardRoot, realCardRoot)) return 'reserved-card';

      const root = parse(expandedPath).root;
      const components = relative(root, expandedPath).split(sep).filter((component) => component.length > 0);
      let prefix = root;
      let restarted = false;

      for (let index = 0; index < components.length; index += 1) {
        const componentPath = join(prefix, components[index]!);
        let stat;
        try {
          stat = lstatSync(componentPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'generic';
          return 'indeterminate';
        }

        if (!stat.isSymbolicLink()) {
          prefix = componentPath;
          continue;
        }

        if (expansions >= MAX_CLASSIFIER_SYMLINK_EXPANSIONS || followedLinks.has(componentPath)) return 'indeterminate';
        followedLinks.add(componentPath);
        expansions += 1;

        let linkDestination: string;
        try {
          linkDestination = readlinkSync(componentPath);
        } catch {
          return 'indeterminate';
        }
        const destination = isAbsolute(linkDestination)
          ? resolve(linkDestination)
          : resolve(dirname(componentPath), linkDestination);
        expandedPath = resolve(destination, ...components.slice(index + 1));
        if (isReservedCardPath(expandedPath, lexicalCardRoot, realCardRoot)) return 'reserved-card';
        if (expandedPaths.has(expandedPath)) return 'indeterminate';
        expandedPaths.add(expandedPath);
        restarted = true;
        break;
      }

      if (!restarted) return 'generic';
    }
  }

  private admitLexicalProjectPath(
    requestedLexicalPath: string,
    responsePath: string,
    allowCanonicalCardDispatch: boolean,
  ): FilesAdmission {
    if (!requestedLexicalPath) return { kind: 'rejected', reason: 'Path is required.', responsePath };
    if (requestedLexicalPath.includes('..')) {
      return { kind: 'rejected', reason: 'Path traversal detected. Use of ".." is not allowed.', responsePath };
    }

    const projectRoot = resolve(this.projectRoot);
    const absolutePath = resolve(requestedLexicalPath.startsWith('/') ? requestedLexicalPath : resolve(projectRoot, requestedLexicalPath));
    if (!isContainedPath(projectRoot, absolutePath)) {
      return { kind: 'rejected', reason: 'Path is outside the project root.', responsePath };
    }
    const rel = relative(projectRoot, absolutePath).split(sep).join('/') || '.';
    const admittedResponsePath = allowCanonicalCardDispatch ? rel : responsePath;
    if (isReadBlocked(rel)) {
      return {
        kind: 'rejected',
        reason: `Access to "${admittedResponsePath}" is blocked for security reasons.`,
        responsePath: admittedResponsePath,
        blockedSource: true,
      };
    }

    if (rel === SAIVAGE_CARDS_RELATIVE_DIR || rel.startsWith(`${SAIVAGE_CARDS_RELATIVE_DIR}/`)) {
      return { kind: 'reserved-card' };
    }

    const aliasClassification = this.classifyAllowedNonCardAlias(rel);
    if (aliasClassification === 'reserved-card') return { kind: 'reserved-card' };
    if (aliasClassification === 'indeterminate') return { kind: 'rejected', reason: CANNOT_RESOLVE_REASON, responsePath };
    return { kind: 'generic' };
  }

  private admitRequestedPath(requestedPath: string): FilesAdmission {
    if (!requestedPath.startsWith('work:///')) return this.admitLexicalProjectPath(requestedPath, requestedPath, true);

    let parsed;
    try {
      parsed = parseScopedPathUrl(requestedPath, 'work');
    } catch (error) {
      return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error), responsePath: requestedPath };
    }
    if (parsed.query !== null || parsed.hadFragment || buildScopedPathUrl('work', parsed.segments) !== requestedPath) {
      return { kind: 'rejected', reason: 'Invalid work URL.', responsePath: requestedPath };
    }
    const derivedProjectPath = `${SAIVAGE_WORK_RELATIVE_DIR}/${parsed.segments.join('/')}`;
    return this.admitLexicalProjectPath(derivedProjectPath, requestedPath, false);
  }

  private reservedListResult(requestedPath: string): WorkspaceFilesListResult {
    return this.canonicalCards.list(requestedPath);
  }

  private reservedContentResult(requestedPath: string): WorkspaceFileContentResult {
    return this.canonicalCards.content(requestedPath);
  }

  listFiles(requestedPath = '.'): WorkspaceFilesListResult {
    const admission = this.admitRequestedPath(requestedPath);
    if (admission.kind === 'rejected') return { statusCode: 403, body: { error: admission.reason } };
    if (admission.kind === 'reserved-card') return this.reservedListResult(requestedPath);
    const resolvedPath = this.resolveRequestedPath(requestedPath);
    if (!resolvedPath.safe) return { statusCode: 403, body: { error: resolvedPath.reason } };
    if (this.isBlockedPath(resolvedPath)) return { statusCode: 403, body: { error: `Access to "${resolvedPath.responsePath}" is blocked for security reasons.` } };
    const { absolutePath, responsePath, kind } = resolvedPath;
    if (!existsSync(absolutePath)) return { statusCode: 404, body: { error: 'Path not found', path: responsePath } };
    const pathStat = statSync(absolutePath);
    if (!pathStat.isDirectory()) return { statusCode: 400, body: { error: 'Path is not a directory', path: responsePath } };
    const files = readdirSync(absolutePath).flatMap((entry: string): WorkspaceFilesListResponse['files'] => {
      const entryAbsolutePath = join(absolutePath, entry);
      const lexicalEntryPath = relative(resolve(this.projectRoot), entryAbsolutePath).split(sep).join('/');
      if (kind === 'project' && resolvedPath.policyRelativePath === '.saivage' && entry === 'cards' && lexicalEntryPath === SAIVAGE_CARDS_RELATIVE_DIR) {
        const row = this.canonicalCards.syntheticCardsRow();
        return row ? [row] : [];
      }
      const childAdmission = this.admitLexicalProjectPath(lexicalEntryPath, lexicalEntryPath, false);
      if (childAdmission.kind !== 'generic') return [];
      const containedEntry = resolveContainedProjectPath(this.projectRoot, lexicalEntryPath);
      if (!containedEntry.safe || !containedEntry.relativePath) return [];
      const entryPolicyPath = { policyRelativePath: containedEntry.relativePath, realTargetProjectRelativePath: containedEntry.realTargetProjectRelativePath };
      if (this.isBlockedPath(entryPolicyPath)) return [];
      try {
        const entryStat = statSync(containedEntry.absolutePath);
        return [{ name: entry, path: kind === 'work' ? workUrlFromAbsolutePath(this.projectRoot, containedEntry.absolutePath) : containedEntry.relativePath, type: entryStat.isDirectory() ? 'directory' : 'file', size: entryStat.isFile() ? entryStat.size : undefined, modifiedAt: entryStat.mtime.toISOString() }];
      } catch { return []; }
    });
    return { body: { path: responsePath, files } };
  }

  readFileContent(requestedPath: string | undefined): WorkspaceFileContentResult {
    if (!requestedPath) return { statusCode: 400, body: { error: 'Path query parameter is required.' } };
    if (requestedPath.startsWith('record:///')) {
      const request = parseRecordContentRequest(requestedPath);
      if (request.kind === 'invalid') return { statusCode: 400, body: { error: request.error, path: requestedPath } };
      try {
        const record = this.records().record(request.cardId, request.filename, request.version);
        if (record.artifact.state !== 'closed') return { statusCode: 404, body: { error: 'Closed record not found.', path: requestedPath } };
        return { body: { path: record.recordUrl, size: Buffer.byteLength(record.artifact.content), contentType: 'text/markdown', content: record.artifact.content, redacted: false, sensitivity: 'normal', version: record.version, modifiedAt: record.artifact.committed_at } };
      } catch (error) {
        if (error instanceof AuthoredRecordNotFoundError) return { statusCode: 404, body: { error: 'Closed record not found.', path: requestedPath } };
        throw error;
      }
    }
    const admission = this.admitRequestedPath(requestedPath);
    if (admission.kind === 'rejected') {
      return admission.blockedSource
        ? { statusCode: 403, body: { error: admission.reason, path: admission.responsePath } }
        : { statusCode: 403, body: { error: admission.reason } };
    }
    if (admission.kind === 'reserved-card') return this.reservedContentResult(requestedPath);
    const resolvedPath = this.resolveRequestedPath(requestedPath);
    if (!resolvedPath.safe) return { statusCode: 403, body: { error: resolvedPath.reason } };
    if (this.isBlockedPath(resolvedPath)) return { statusCode: 403, body: { error: `Access to "${resolvedPath.responsePath}" is blocked for security reasons.`, path: resolvedPath.responsePath } };
    const { absolutePath, responsePath } = resolvedPath;
    if (!existsSync(absolutePath)) return { statusCode: 404, body: { error: 'File not found', path: responsePath } };
    const fileStat = statSync(absolutePath);
    if (fileStat.isDirectory()) return { statusCode: 400, body: { error: 'Path is a directory', path: responsePath } };
    if (fileStat.size > MAX_FILE_SIZE_BYTES) return { statusCode: 413, body: { error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`, path: responsePath, size: fileStat.size, maxSize: MAX_FILE_SIZE_BYTES } };
    const rawBuffer = readFileSync(absolutePath);
    if (isBinaryBuffer(rawBuffer)) return { statusCode: 415, body: { error: 'Binary or non-text file cannot be previewed.', path: responsePath } };
    if (this.isSelectedConfig(absolutePath)) {
      const effective = this.configAuthority.loadEffective();
      const projected = redactForOutbound({ source: 'config', value: effective.config });
      return {
        body: {
          path: responsePath,
          size: fileStat.size,
          contentType: 'application/json',
          content: `${JSON.stringify(projected, null, 2)}\n`,
          redacted: true,
          sensitivity: 'sensitive-redacted',
        },
      };
    }
    const redacted = this.isWorkPath(resolvedPath) || this.isRedactedPath(resolvedPath);
    const content = rawBuffer.toString('utf-8');
    return { body: { path: responsePath, size: fileStat.size, contentType: 'text/plain', content: redacted ? redactTextForOutbound(content) : content, redacted, sensitivity: redacted ? 'sensitive-redacted' : 'normal' } };
  }

}
