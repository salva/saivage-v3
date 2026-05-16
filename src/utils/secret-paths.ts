import { basename, normalize, resolve } from 'node:path';

export const SECRET_BASENAMES: readonly RegExp[] = [
  /^auth-profiles\.json$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^[^/]+\.(?:pem|key|pfx)$/i,
  /^\.env(?:\.[^/]+)?$/i,
  /^credentials$/i,
  /^cookies\.txt$/i,
];

export const SECRET_PATH_FRAGMENTS: readonly string[] = [
  '/.saivage/auth-profiles',
  '/.ssh/',
  '/.aws/',
  '/.config/gcloud/',
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

export function looksLikeSecretPath(absolutePath: string): boolean {
  if (!absolutePath) return false;
  const normalized = normalizePath(absolutePath);
  const lower = normalized.toLowerCase();
  const base = basename(lower);

  if (SECRET_PATH_FRAGMENTS.some((fragment) => lower.includes(fragment.toLowerCase()))) return true;
  if (SECRET_BASENAMES.some((pattern) => pattern.test(base))) return true;
  if (/(?:^|\/)\.git\/(?:.*(?:token|auth)|objects\/)/i.test(lower)) return true;
  if (base === '.npmrc' || base === '.pypirc') return true;

  return false;
}

export function assertNotSecretPath(absolutePath: string): void {
  if (looksLikeSecretPath(absolutePath)) {
    throw new SecretPathError(absolutePath);
  }
}
