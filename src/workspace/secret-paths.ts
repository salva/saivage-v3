import { basename, normalize, resolve } from 'node:path';

export const SECRET_BASENAMES: readonly RegExp[] = [
  /^auth-profiles(?:\.[^/]+)?$/i,
  /^id_rsa(?:\.pub)?$/i,
  /^id_ed25519(?:\.pub)?$/i,
  /^[^/]+\.(?:pem|key|pfx)$/i,
  /^\.env(?:\.[^/]+)?$/i,
  /^credentials$/i,
  /^cookies\.txt$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

export const SECRET_PATH_FRAGMENTS: readonly string[] = [
  '/.saivage/auth-profiles',
  '/.ssh',
  '/.aws',
  '/.config/gcloud',
  '/.git/objects',
  '/.git/token',
  '/.git/auth',
  '/.npmrc',
  '/.pypirc',
];

export class SecretPathError extends Error {
  constructor(path: string) {
    super(`Access denied: secret-bearing path is off-limits (${path}). Use safer inspection paths that do not touch secrets.`);
    this.name = 'SecretPathError';
  }
}

function normalizePath(path: string): string {
  return normalize(resolve(path)).replace(/\\/g, '/');
}

function hasSecretFragment(normalizedLowerPath: string): boolean {
  return SECRET_PATH_FRAGMENTS.some((fragment) => {
    const lowerFragment = fragment.toLowerCase();
    const bareFragment = lowerFragment.slice(1);
    return normalizedLowerPath === lowerFragment
      || normalizedLowerPath === bareFragment
      || normalizedLowerPath.endsWith(lowerFragment)
      || normalizedLowerPath.endsWith(`/${bareFragment}`)
      || normalizedLowerPath.startsWith(`${lowerFragment}/`)
      || normalizedLowerPath.startsWith(`${bareFragment}/`)
      || normalizedLowerPath.includes(`${lowerFragment}/`);
  });
}

function looksLikeSecretBasename(name: string): boolean {
  return SECRET_BASENAMES.some((pattern) => pattern.test(name));
}

export function looksLikeSecretPath(absolutePath: string): boolean {
  if (!absolutePath) return false;
  const normalized = normalizePath(absolutePath);
  const lower = normalized.toLowerCase();
  const base = basename(lower);

  if (hasSecretFragment(lower)) return true;
  if (looksLikeSecretBasename(base)) return true;
  if (/(?:^|\/)\.git\/(?:.*(?:token|auth)(?:[^/]*|\/.*)|objects(?:\/.*)?)$/i.test(lower)) return true;

  return false;
}

export function assertNotSecretPath(absolutePath: string): void {
  if (looksLikeSecretPath(absolutePath)) {
    throw new SecretPathError(absolutePath);
  }
}
