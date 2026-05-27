import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSafeFileForAgent, resolveContainedProjectPath } from '../../workspace/index.js';

const MAX_FILE_SIZE_BYTES = 1_048_576;
const BINARY_SAMPLE_BYTES = 4096;

export type WorkspaceFileResult = { statusCode?: number; body: unknown };

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
  constructor(private readonly projectRoot: string) {}

  listFiles(requestedPath = '.'): WorkspaceFileResult {
    const { safe, absolutePath, reason, relativePath } = resolveContainedProjectPath(this.projectRoot, requestedPath);
    if (!safe) return { statusCode: 403, body: { error: reason } };
    const responsePath = relativePath ?? '.';
    if (!existsSync(absolutePath)) return { statusCode: 404, body: { error: 'Path not found', path: responsePath } };
    const pathStat = statSync(absolutePath);
    if (!pathStat.isDirectory()) return { statusCode: 400, body: { error: 'Path is not a directory', path: responsePath } };
    const files = readdirSync(absolutePath).flatMap((entry: string) => {
      const lexicalEntryPath = join(responsePath === '.' ? '' : responsePath, entry).replace(/^$/, entry).replace(/\\/g, '/');
      const containedEntry = resolveContainedProjectPath(this.projectRoot, lexicalEntryPath);
      if (!containedEntry.safe || !containedEntry.relativePath || !existsSync(containedEntry.absolutePath)) return [];
      try {
        const linkStats = lstatSync(join(absolutePath, entry));
        if (linkStats.isSymbolicLink()) {
          const resolvedLink = resolveContainedProjectPath(this.projectRoot, join(absolutePath, entry));
          if (!resolvedLink.safe) return [];
        }
        const entryStat = statSync(containedEntry.absolutePath);
        return [{ name: entry, path: containedEntry.relativePath, type: entryStat.isDirectory() ? 'directory' : 'file', size: entryStat.isFile() ? entryStat.size : undefined, modifiedAt: entryStat.mtime.toISOString() }];
      } catch { return []; }
    });
    return { body: { path: responsePath, files } };
  }

  readFileContent(requestedPath: string | undefined): WorkspaceFileResult {
    if (!requestedPath) return { statusCode: 400, body: { error: 'Path query parameter is required.' } };
    const { safe, absolutePath, reason, relativePath } = resolveContainedProjectPath(this.projectRoot, requestedPath);
    if (!safe) return { statusCode: 403, body: { error: reason } };
    const responsePath = relativePath ?? '.';
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
}
