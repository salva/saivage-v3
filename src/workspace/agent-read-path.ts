import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { hasParentPathSegment, looksLikeSecretPath } from './file-access-security.js';

export function isWithinReadRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export function resolveNativeReadPath(
  projectRoot: string,
  raw: string,
  fail: (message: string) => Error,
): { absolutePath: string; relativePath: string } {
  if (!raw) throw fail('Path is required.');
  if (!isAbsolute(raw) && hasParentPathSegment(raw))
    throw fail('Path traversal detected. Use of ".." is not allowed.');
  const absolutePath = resolve(projectRoot, raw);
  return {
    absolutePath,
    relativePath: isWithinReadRoot(resolve(projectRoot), absolutePath)
      ? relative(projectRoot, absolutePath) || '.'
      : absolutePath,
  };
}

/** Explicit work/tmp resources admit only their own namespace, not other private state. */
function isAgentReadBlocked(absolutePath: string, resourceRoot?: string): boolean {
  if (looksLikeSecretPath(absolutePath)) return true;
  const identity =
    resourceRoot && isWithinReadRoot(resourceRoot, absolutePath)
      ? relative(resourceRoot, absolutePath)
      : absolutePath;
  return identity.split('/').includes('.saivage');
}

export function inspectAgentReadPath(
  absolutePath: string,
  resourceRoot?: string,
): { blocked: boolean; realPath: string } {
  // Lexical secrets are refused even when their target is innocuous or absent.
  if (isAgentReadBlocked(absolutePath, resourceRoot))
    return { blocked: true, realPath: absolutePath };
  const realPath = realpathSync(absolutePath);
  const realResourceRoot = resourceRoot ? realpathSync(resourceRoot) : undefined;
  return { blocked: isAgentReadBlocked(realPath, realResourceRoot), realPath };
}
