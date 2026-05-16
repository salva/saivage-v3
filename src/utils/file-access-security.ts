import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { normalize, relative, resolve, sep } from 'node:path';
import { looksLikeSecretPath as sharedLooksLikeSecretPath } from './secret-paths.js';

export const SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
  '.saivage/saivage.json',
  '.saivage-work/tmp/runtime/runtime.lock',
]);

export const READ_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
]);

export const WRITE_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
  '.saivage-work/tmp/runtime/runtime.lock',
]);

export const REDACT_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.json',
]);

export function sanitizeFilePath(filePath: string): string {
  if (!filePath) return '';

  let cleaned = normalize(filePath);

  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  }

  cleaned = cleaned.replace(/[/\\]+$/, '');

  return cleaned;
}

export function isSensitivePath(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return SENSITIVE_PATHS.has(clean);
}

export function isReadBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return READ_BLOCKED_PATHS.has(clean);
}

export function isWriteBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return WRITE_BLOCKED_PATHS.has(clean);
}

export function isRedacted(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return REDACT_PATHS.has(clean);
}

export function looksLikeSecretPath(filePath: string): boolean {
  return sharedLooksLikeSecretPath(filePath);
}

const REDACT_KEY_PATTERN =
  /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password)\b/i;

const REDACT_VALUE_RE =
  /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;

const CREDENTIAL_LITERAL_RE = /\b(sk-[^\s"\\]+|tid=[^\s"\\]+|ghu_[A-Za-z0-9_]+|rt_[^\s"\\]+|tok_[^\s"\\]+)\b/g;

function redactCredentialMatch(match: string): string {
  const prefix = match.startsWith('sk-') ? 'sk' :
    match.startsWith('tid=') ? 'tid' :
      match.startsWith('ghu_') ? 'ghu' :
        match.startsWith('rt_') ? 'rt' :
          match.startsWith('tok_') ? 'tok' : 'credential';
  return `${prefix}-[REDACTED]`;
}

export function redactSecrets(content: string): string {
  if (!content) return content;

  const jsonRedacted = content.replace(REDACT_VALUE_RE, (_match, keyPart, wsBefore, wsAfter, valuePart) => {
    const keyInner = keyPart.slice(1, -1);

    if (!REDACT_KEY_PATTERN.test(keyInner)) {
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    if (/\$\{[^}]+\}/.test(valuePart)) {
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    return `${keyPart}${wsBefore}:${wsAfter}"[REDACTED]"`;
  });

  return jsonRedacted.replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch);
}

export function redactCredentialLiterals(content: string): string {
  if (!content) return content;
  return content.replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch);
}

export function redactOperatorErrorMessage(message: string, projectRoot?: string): string {
  let redacted = redactCredentialLiterals(message);
  if (projectRoot) {
    const resolvedRoot = resolve(projectRoot);
    redacted = redacted.split(resolvedRoot).join('[PROJECT_ROOT]');
  }
  return redacted.replace(/([A-Za-z]:)?(?:\/[^\s:]+)+/g, (pathLike) => {
    if (pathLike === '[PROJECT_ROOT]') {
      return pathLike;
    }
    return pathLike.startsWith('.saivage') || pathLike.startsWith('.saivage-work')
      ? pathLike
      : '[PATH_REDACTED]';
  });
}

export function redactCommandForOperator(command: string): string {
  return redactCredentialLiterals(command);
}

export interface SafeProjectPathResult {
  safe: boolean;
  absolutePath: string;
  relativePath?: string;
  reason?: string;
}

export interface SafeContainedFileMetadata {
  path: string;
  exists: boolean;
  type?: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  blocked?: boolean;
  reason?: string;
}

export function resolveContainedProjectPath(
  projectRoot: string,
  requestedPath: string,
): SafeProjectPathResult {
  if (!requestedPath) {
    return { safe: false, absolutePath: '', reason: 'Path is required.' };
  }

  if (requestedPath.includes('..')) {
    return {
      safe: false,
      absolutePath: '',
      reason: 'Path traversal detected. Use of ".." is not allowed.',
    };
  }

  const resolvedRoot = resolve(projectRoot);
  const normalized = requestedPath.startsWith('/') ? requestedPath : resolve(projectRoot, requestedPath);
  const resolvedPath = resolve(normalized);

  if (!resolvedPath.startsWith(resolvedRoot + sep) && resolvedPath !== resolvedRoot) {
    return {
      safe: false,
      absolutePath: '',
      reason: 'Path is outside the project root.',
    };
  }

  if (existsSync(resolvedPath)) {
    try {
      const realPath = realpathSync(resolvedPath);
      const realRoot = realpathSync(resolvedRoot);
      if (!realPath.startsWith(realRoot + sep) && realPath !== realRoot) {
        return {
          safe: false,
          absolutePath: resolvedPath,
          relativePath: relative(resolvedRoot, resolvedPath).replace(/\\/g, '/') || '.',
          reason: 'Symlink target is outside the project root.',
        };
      }
      const rel = relative(realRoot, realPath).replace(/\\/g, '/');
      return {
        safe: true,
        absolutePath: realPath,
        relativePath: rel === '' ? '.' : rel,
      };
    } catch {
      return {
        safe: false,
        absolutePath: '',
        reason: 'Path cannot be resolved.',
      };
    }
  }

  const rel = relative(resolvedRoot, resolvedPath).replace(/\\/g, '/');
  return {
    safe: true,
    absolutePath: resolvedPath,
    relativePath: rel === '' ? '.' : rel,
  };
}

export function getContainedFileMetadata(projectRoot: string, rawPath: unknown): SafeContainedFileMetadata | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return null;
  }

  const resolved = resolveContainedProjectPath(projectRoot, rawPath.trim());
  if (!resolved.safe || !resolved.relativePath) {
    const fallback = resolved.relativePath ?? toContainedRelativePath(projectRoot, rawPath);
    if (!fallback) {
      return null;
    }
    return {
      path: fallback,
      exists: false,
      blocked: true,
      reason: resolved.reason,
    };
  }

  if (!existsSync(resolved.absolutePath)) {
    return {
      path: resolved.relativePath,
      exists: false,
    };
  }

  try {
    const linkStats = lstatSync(resolved.absolutePath);
    if (linkStats.isSymbolicLink()) {
      const realRoot = realpathSync(resolve(projectRoot));
      const realPath = realpathSync(resolved.absolutePath);
      if (!realPath.startsWith(realRoot + sep) && realPath !== realRoot) {
        return {
          path: resolved.relativePath,
          exists: false,
          blocked: true,
          reason: 'Symlink target is outside the project root.',
        };
      }
    }

    const stats = statSync(resolved.absolutePath);
    return {
      path: resolved.relativePath,
      exists: true,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.isFile() ? stats.size : undefined,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      path: resolved.relativePath,
      exists: false,
    };
  }
}

export function toContainedRelativePath(projectRoot: string, rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return null;
  }

  const resolved = resolveContainedProjectPath(projectRoot, rawPath.trim());
  if (!resolved.safe || !resolved.relativePath) {
    return null;
  }

  return resolved.relativePath;
}

export type SafeFileSensitivity = 'normal' | 'sensitive-blocked' | 'sensitive-redacted';

export interface SafeGeneratedFileClassification {
  sensitivity: SafeFileSensitivity;
  blocked: boolean;
  previewable: boolean;
  downloadable: boolean;
  redactedOnly: boolean;
}

export function classifyGeneratedFilePath(filePath: string): SafeGeneratedFileClassification {
  if (isReadBlocked(filePath)) {
    return {
      sensitivity: 'sensitive-blocked',
      blocked: true,
      previewable: false,
      downloadable: false,
      redactedOnly: false,
    };
  }

  if (isRedacted(filePath)) {
    return {
      sensitivity: 'sensitive-redacted',
      blocked: false,
      previewable: true,
      downloadable: false,
      redactedOnly: true,
    };
  }

  return {
    sensitivity: 'normal',
    blocked: false,
    previewable: true,
    downloadable: true,
    redactedOnly: false,
  };
}

export function isStashPathAllowed(stashDir: string, requestedPath: string): boolean {
  if (!requestedPath || !stashDir) return false;

  const resolvedStash = resolve(stashDir);
  const resolvedRequested = resolve(stashDir, requestedPath);

  const stashNorm = resolvedStash.endsWith(sep) ? resolvedStash : resolvedStash + sep;
  const reqNorm = resolvedRequested.endsWith(sep) ? resolvedRequested : resolvedRequested + sep;

  return reqNorm.startsWith(stashNorm);
}

export interface SafeFileResult {
  blocked: boolean;
  safeContent?: string;
  reason?: string;
}

export function getSafeFileForAgent(
  filePath: string,
  content: string,
): SafeFileResult {
  if (isReadBlocked(filePath)) {
    return {
      blocked: true,
      reason: `Access to "${filePath}" is blocked for security reasons.`,
    };
  }

  if (isRedacted(filePath)) {
    return {
      blocked: false,
      safeContent: redactSecrets(content),
      reason: `Secrets in "${filePath}" have been redacted.`,
    };
  }

  return {
    blocked: false,
    safeContent: content,
  };
}
