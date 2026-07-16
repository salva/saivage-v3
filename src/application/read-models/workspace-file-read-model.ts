import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildScopedPathUrl, parseScopedPathUrl } from '../../contracts/scoped-path-url.js';
import { getSafeFileForAgent, resolveContainedProjectPath, workUrlFromAbsolutePath } from '../../workspace/index.js';
import { SAIVAGE_WORK_RELATIVE_DIR } from '../../persistence/layout.js';
interface ProjectCardRecordReader {
  record(cardId: string, filename: string, version: number | 'latest' | 'open'): {
    recordUrl: string;
    version: number;
    artifact: { state: string; content: string; committed_at?: string | null };
  };
  isActiveCardId(cardId: string): boolean;
}

const MAX_FILE_SIZE_BYTES = 1_048_576;
const BINARY_SAMPLE_BYTES = 4096;

export type WorkspaceFileResult = { statusCode?: number; body: unknown };

interface ResolvedRequestPath {
  safe: boolean;
  absolutePath: string;
  responsePath: string;
  reason?: string;
  kind: 'project' | 'work';
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

export class WorkspaceFileReadModelService {
  constructor(private readonly projectRoot: string, private readonly records?: () => ProjectCardRecordReader) {}

  private resolveRequestedPath(requestedPath: string): ResolvedRequestPath {
    if (requestedPath.startsWith('work:///')) {
      try {
        const parsed = parseScopedPathUrl(requestedPath, 'work');
        if (parsed.query !== null || parsed.hadFragment || buildScopedPathUrl('work', parsed.segments) !== requestedPath) return { safe: false, absolutePath: '', responsePath: requestedPath, reason: 'Invalid work URL.', kind: 'work' };
        const resolved = resolveContainedProjectPath(this.projectRoot, `${SAIVAGE_WORK_RELATIVE_DIR}/${parsed.segments.join('/')}`);
        return { safe: resolved.safe, absolutePath: resolved.absolutePath, responsePath: requestedPath, reason: resolved.reason, kind: 'work' };
      } catch (err) {
        return { safe: false, absolutePath: '', responsePath: requestedPath, reason: err instanceof Error ? err.message : String(err), kind: 'work' };
      }
    }
    const resolved = resolveContainedProjectPath(this.projectRoot, requestedPath);
    return { safe: resolved.safe, absolutePath: resolved.absolutePath, responsePath: resolved.relativePath ?? requestedPath, reason: resolved.reason, kind: 'project' };
  }

  listFiles(requestedPath = '.'): WorkspaceFileResult {
    if (this.inactiveCardPath(requestedPath)) return { statusCode: 404, body: { error: 'Path not found', path: requestedPath } };
    const { safe, absolutePath, reason, responsePath, kind } = this.resolveRequestedPath(requestedPath);
    if (!safe) return { statusCode: 403, body: { error: reason } };
    if (!existsSync(absolutePath)) return { statusCode: 404, body: { error: 'Path not found', path: responsePath } };
    const pathStat = statSync(absolutePath);
    if (!pathStat.isDirectory()) return { statusCode: 400, body: { error: 'Path is not a directory', path: responsePath } };
    const files = readdirSync(absolutePath).flatMap((entry: string) => {
      const entryAbsolutePath = join(absolutePath, entry);
      const lexicalEntryPath = relative(this.projectRoot, entryAbsolutePath).replace(/\\/g, '/');
      const containedEntry = resolveContainedProjectPath(this.projectRoot, lexicalEntryPath);
      if (!containedEntry.safe || !containedEntry.relativePath || !existsSync(containedEntry.absolutePath)) return [];
      try {
        const linkStats = lstatSync(entryAbsolutePath);
        if (linkStats.isSymbolicLink()) {
          const resolvedLink = resolveContainedProjectPath(this.projectRoot, entryAbsolutePath);
          if (!resolvedLink.safe) return [];
        }
        const entryStat = statSync(containedEntry.absolutePath);
        return [{ name: entry, path: kind === 'work' ? workUrlFromAbsolutePath(this.projectRoot, containedEntry.absolutePath) : containedEntry.relativePath, type: entryStat.isDirectory() ? 'directory' : 'file', size: entryStat.isFile() ? entryStat.size : undefined, modifiedAt: entryStat.mtime.toISOString() }];
      } catch { return []; }
    });
    return { body: { path: responsePath, files } };
  }

  readFileContent(requestedPath: string | undefined): WorkspaceFileResult {
    if (!requestedPath) return { statusCode: 400, body: { error: 'Path query parameter is required.' } };
    if (this.inactiveCardPath(requestedPath)) return { statusCode: 404, body: { error: 'File not found', path: requestedPath } };
    if (requestedPath.startsWith('record:///')) {
      if (!this.records) return { statusCode: 503, body: { error: 'Record read model is unavailable.' } };
      try {
        const parsed = parseScopedPathUrl(requestedPath, 'record');
        if (parsed.segments.length !== 1 || !parsed.query) return { statusCode: 400, body: { error: 'Invalid record URL.', path: requestedPath } };
        const cardId = parsed.query.get('card'); const rawVersion = parsed.query.get('v') ?? 'latest';
        if (!cardId) return { statusCode: 400, body: { error: 'Record URL requires card.', path: requestedPath } };
        const version = rawVersion === 'latest' ? 'latest' : Number(rawVersion);
        if (version !== 'latest' && (!Number.isSafeInteger(version) || version < 1)) return { statusCode: 400, body: { error: 'Invalid record version.', path: requestedPath } };
        const record = this.records().record(cardId, parsed.segments[0]!, version);
        if (record.artifact.state !== 'closed') return { statusCode: 404, body: { error: 'Closed record not found.', path: requestedPath } };
        return { body: { path: record.recordUrl, size: Buffer.byteLength(record.artifact.content), contentType: 'text/markdown', content: record.artifact.content, redacted: false, sensitivity: 'normal', version: record.version, modifiedAt: record.artifact.committed_at } };
      } catch (error) { return { statusCode: 404, body: { error: error instanceof Error ? error.message : String(error), path: requestedPath } }; }
    }
    const { safe, absolutePath, reason, responsePath } = this.resolveRequestedPath(requestedPath);
    if (!safe) return { statusCode: 403, body: { error: reason } };
    if (!existsSync(absolutePath)) return { statusCode: 404, body: { error: 'File not found', path: responsePath } };
    const fileStat = statSync(absolutePath);
    if (fileStat.isDirectory()) return { statusCode: 400, body: { error: 'Path is a directory', path: responsePath } };
    if (fileStat.size > MAX_FILE_SIZE_BYTES) return { statusCode: 413, body: { error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes.`, path: responsePath, size: fileStat.size, maxSize: MAX_FILE_SIZE_BYTES } };
    const rawBuffer = readFileSync(absolutePath);
    if (isBinaryBuffer(rawBuffer)) return { statusCode: 415, body: { error: 'Binary or non-text file cannot be previewed.', path: responsePath } };
    const safeResult = getSafeFileForAgent(responsePath, rawBuffer.toString('utf-8'));
    if (safeResult.blocked) return { statusCode: 403, body: { error: safeResult.reason || 'Access to this file is blocked for security reasons.', path: responsePath } };
    return { body: { path: responsePath, size: fileStat.size, contentType: 'text/plain', content: safeResult.safeContent, redacted: Boolean(safeResult.reason), sensitivity: safeResult.reason ? 'sensitive-redacted' : 'normal' } };
  }

  private inactiveCardPath(requestedPath: string): boolean {
    if (!this.records) return false;
    const match = /^\.saivage\/cards\/([^/]+)(?:\/|$)/u.exec(requestedPath.replace(/^\.\//u, ''));
    return match !== null && !this.records().isActiveCardId(match[1]!);
  }
}
