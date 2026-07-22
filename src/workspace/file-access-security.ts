import { existsSync, realpathSync } from 'node:fs';
import { normalize, relative, resolve, sep } from 'node:path';
import {
  looksLikeSecretPath as sharedLooksLikeSecretPath,
  assertNotSecretPath,
} from './secret-paths.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { redactCommandForPolicy } from '../runtime/command-policy.js';

export {
  isSecretLikeKey,
  redactAnalystSecretValue,
} from './secret-redaction.js';

const NON_SECRET_READ_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.json',
]);

const NON_SECRET_REDACT_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.yaml',
]);

function sanitizeFilePath(filePath: string): string {
  if (!filePath) return '';

  let cleaned = normalize(filePath);

  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  }

  cleaned = cleaned.replace(/[/\\]+$/, '');

  return cleaned;
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
  return sharedLooksLikeSecretPath(clean) || clean.startsWith('.saivage/locks/');
}

export function isRedacted(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return NON_SECRET_REDACT_PATHS.has(clean);
}

export function looksLikeSecretPath(filePath: string): boolean {
  return sharedLooksLikeSecretPath(filePath);
}


export function redactOperatorErrorMessage(message: string, projectRoot?: string): string {
  let redacted: string = redactTextForOutbound(message);
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

interface SafeProjectPathResult {
  safe: boolean;
  absolutePath: string;
  relativePath?: string;
  realTargetProjectRelativePath?: string;
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
          relativePath: relative(resolvedRoot, resolvedPath).split(sep).join('/') || '.',
          reason: 'Symlink target is outside the project root.',
        };
      }
      const rel = relative(resolvedRoot, resolvedPath).split(sep).join('/');
      const realTargetRel = relative(realRoot, realPath).split(sep).join('/');
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

  const rel = relative(resolvedRoot, resolvedPath).split(sep).join('/');
  return {
    safe: true,
    absolutePath: resolvedPath,
    relativePath: rel === '' ? '.' : rel,
  };
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
