import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { normalize, relative, resolve, sep } from 'node:path';
import {
  looksLikeSecretPath as sharedLooksLikeSecretPath,
  assertNotSecretPath,
} from './secret-paths.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { redactCommandForPolicy } from '../runtime/command-policy.js';

export {
  assertAnalystInspectionTarget,
  isAnalystSecretPath,
  isSecretLikeKey,
  redactAnalystSecretValue,
} from './secret-redaction.js';

const NON_SECRET_SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.yaml',
]);

const NON_SECRET_READ_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.json',
]);

const NON_SECRET_WRITE_BLOCKED_PATHS: ReadonlySet<string> = new Set([]);

const NON_SECRET_REDACT_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.yaml',
]);

export const SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  ...NON_SECRET_SENSITIVE_PATHS,
]);

export const READ_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  ...NON_SECRET_READ_BLOCKED_PATHS,
]);

export const WRITE_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  ...NON_SECRET_WRITE_BLOCKED_PATHS,
]);

export const REDACT_PATHS: ReadonlySet<string> = new Set([
  ...NON_SECRET_REDACT_PATHS,
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
  return sharedLooksLikeSecretPath(clean) || NON_SECRET_SENSITIVE_PATHS.has(clean) || NON_SECRET_READ_BLOCKED_PATHS.has(clean) || clean === '.saivage/locks' || clean.startsWith('.saivage/locks/');
}

export function isReadBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  if (clean === '.saivage/locks' || clean.startsWith('.saivage/locks/')) return true;
  if (NON_SECRET_READ_BLOCKED_PATHS.has(clean)) return true;
  try {
    assertNotSecretPath(clean);
    return false;
  } catch {
    return true;
  }
}

export function isWriteBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  if (sharedLooksLikeSecretPath(clean)) {
    return true;
  }
  return NON_SECRET_WRITE_BLOCKED_PATHS.has(clean) || clean.startsWith('.saivage/locks/');
}

export function isRedacted(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return NON_SECRET_REDACT_PATHS.has(clean);
}

export function looksLikeSecretPath(filePath: string): boolean {
  return sharedLooksLikeSecretPath(filePath);
}


export function redactOperatorErrorMessage(message: string, projectRoot?: string): string {
  let redacted: string = redactTextForOutbound(message, 'operator.api', { source: 'file-access-security.error-message' });
  if (projectRoot) {
    const resolvedRoot = resolve(projectRoot);
    redacted = redacted.split(resolvedRoot).join('[PROJECT_ROOT]');
  }
  return redacted.replace(/(\.saivage)?([A-Za-z]:)?(?:\/[^\s:]+)+/g, (pathLike) => {
    if (pathLike === '[PROJECT_ROOT]') {
      return pathLike;
    }
    return pathLike.startsWith('.saivage')
      ? pathLike
      : '[PATH_REDACTED]';
  });
}

export function redactCommandForOperator(command: string): string {
  return redactCommandForPolicy(command);
}

export interface SafeProjectPathResult {
  safe: boolean;
  absolutePath: string;
  relativePath?: string;
  realTargetProjectRelativePath?: string;
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
      const rel = relative(resolvedRoot, resolvedPath).replace(/\\/g, '/');
      const realTargetRel = relative(realRoot, realPath).replace(/\\/g, '/');
      return {
        safe: true,
        absolutePath: resolvedPath,
        relativePath: rel === '' ? '.' : rel,
        realTargetProjectRelativePath: realTargetRel === '' ? '.' : realTargetRel,
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
