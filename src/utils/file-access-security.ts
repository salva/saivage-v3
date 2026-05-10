/**
 * File Access Security
 *
 * Implements sensitive file blocking and secret redaction as
 * described in 05-security.md § "Sensitive File Protection":
 *
 * | Path                                | Protection         |
 * |-------------------------------------|--------------------|
 * | .saivage/auth-profiles.json         | No read, no write  |
 * | .saivage/saivage.json (secrets)     | Redacted on read   |
 * | .saivage-work/tmp/runtime/runtime.lock | No write        |
 *
 * Also implements stash path security per 04-runtime.md § Stash:
 * read_stash only allows reading from the stash directory;
 * path traversal is rejected.
 */

import { normalize, resolve, sep } from 'node:path';

// ── Sensitive Path Constants ──────────────────────────────────

/**
 * Normalized, project-relative paths that are sensitive.
 *
 * These are matched after normalization so that variants like:
 *   .saivage/auth-profiles.json
 *   ./saivage/auth-profiles.json
 *   .saivage/auth-profiles.json/../auth-profiles.json
 * all resolve to the same canonical entry.
 */
export const SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
  '.saivage/saivage.json',
  '.saivage-work/tmp/runtime/runtime.lock',
]);

/**
 * Paths that are entirely blocked from read access.
 * Currently only auth-profiles.json.
 */
export const READ_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
]);

/**
 * Paths that are entirely blocked from write access.
 * auth-profiles.json AND runtime.lock.
 */
export const WRITE_BLOCKED_PATHS: ReadonlySet<string> = new Set([
  '.saivage/auth-profiles.json',
  '.saivage-work/tmp/runtime/runtime.lock',
]);

/**
 * Paths whose content must be redacted on read.
 * Only saivage.json (contains secrets like API keys).
 */
export const REDACT_PATHS: ReadonlySet<string> = new Set([
  '.saivage/saivage.json',
]);

// ── Path Sanitization ─────────────────────────────────────────

/**
 * Strip leading `./`, normalize `..` segments, and return a clean
 * project-relative path with no trailing slashes.
 *
 * Note: Node's `path.normalize` preserves leading `../` segments
 * that go beyond the current directory root. For example:
 *   normalize('foo/../../bar') → '../bar'
 *   normalize('.saivage/../.saivage/auth-profiles.json') → '.saivage/auth-profiles.json'
 *
 * @param filePath - A raw file path, possibly with `./` prefix or `..` segments.
 * @returns The sanitized path string.
 */
export function sanitizeFilePath(filePath: string): string {
  if (!filePath) return '';

  // Normalize: collapse ., .., and doubling of slashes
  let cleaned = normalize(filePath);

  // Strip a leading './' if present after normalization
  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  }

  // Strip trailing slashes
  cleaned = cleaned.replace(/[/\\]+$/, '');

  return cleaned;
}

// ── Sensitive Path Detection ──────────────────────────────────

/**
 * Check whether a given project-relative file path is in the
 * sensitive paths set.
 *
 * Normalizes the path before checking (resolves `..`, strips `./`).
 *
 * @param filePath - A project-relative or absolute file path.
 * @returns `true` if the path matches a known sensitive path.
 */
export function isSensitivePath(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return SENSITIVE_PATHS.has(clean);
}

/**
 * Check whether reading the given file should be entirely blocked.
 *
 * @param filePath - A project-relative or absolute file path.
 * @returns `true` if the path is in the read-blocked set.
 */
export function isReadBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return READ_BLOCKED_PATHS.has(clean);
}

/**
 * Check whether writing to the given file should be entirely blocked.
 *
 * @param filePath - A project-relative or absolute file path.
 * @returns `true` if the path is in the write-blocked set.
 */
export function isWriteBlocked(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return WRITE_BLOCKED_PATHS.has(clean);
}

/**
 * Check whether the given file should be redacted on read.
 *
 * @param filePath - A project-relative or absolute file path.
 * @returns `true` if the path is in the redact set.
 */
export function isRedacted(filePath: string): boolean {
  const clean = sanitizeFilePath(filePath);
  return REDACT_PATHS.has(clean);
}

// ── Secret Redaction ──────────────────────────────────────────

/**
 * Field names (keys) that trigger redaction when their value
 * is a JSON string literal.  Matched case-insensitively at the
 * JSON key position.
 *
 * Includes:
 *  - `apiKey`, `botToken`
 *  - any key whose base ends in `_key`, `_token`, `secret`, or `password`
 */
const REDACT_KEY_PATTERN =
  /\b(?:apiKey|botToken|(?:api_)?key|.*_(?:key|token|secret|password)|secret|password|accessToken|refreshToken)\b/i;

/**
 * Regex that matches a JSON key-value pair where the value is a
 * quoted string and the key is a secret-sounding name.
 *
 * Captures:
 *   $1 — the full key part including quotes:  "keyName"
 *   $2 — whitespace before the colon
 *   $3 — whitespace after the colon (before the value)
 *   $4 — the value content (without quotes)
 *
 * Values containing `${...}` (env-var references) are NOT redacted.
 */
const REDACT_VALUE_RE =
  /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;

/**
 * Redact API keys, tokens, and other secrets from a string.
 *
 * Works on:
 *  - JSON content: replaces values of secret-sounding keys with `[REDACTED]`
 *  - Plain strings: leaves them unchanged (caller should redact manually
 *    if needed, but the primary use-case is config JSON).
 *
 * Rules:
 *  - Keys matching `REDACT_KEY_PATTERN` have their string values replaced.
 *  - Values that contain `${...}` patterns (env-var references) are
 *    never redacted — they are already references, not literal secrets.
 *  - Raw non-JSON strings are returned unmodified.
 *
 * @param content - The raw content string (typically JSON config content).
 * @returns The content with secret values replaced by `[REDACTED]`.
 */
export function redactSecrets(content: string): string {
  if (!content) return content;

  return content.replace(REDACT_VALUE_RE, (_match, keyPart, wsBefore, wsAfter, valuePart) => {
    // Strip quotes from key for matching
    const keyInner = keyPart.slice(1, -1);

    // Check if this key looks like a secret
    if (!REDACT_KEY_PATTERN.test(keyInner)) {
      // Not a secret key — leave unchanged
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    // Check if the value is an env-var reference (${ENV_VAR})
    // These are already safe — they resolve at runtime
    if (/\$\{[^}]+\}/.test(valuePart)) {
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    // Redact the value, preserving original whitespace around colon
    return `${keyPart}${wsBefore}:${wsAfter}"[REDACTED]"`;
  });
}

// ── Stash Path Security ───────────────────────────────────────

/**
 * Verify that a requested file path is safely within the stash
 * directory.
 *
 * According to 04-runtime.md § Stash:
 *  - read_stash only allows reading from the stash directory
 *  - Path traversal (..) is rejected
 *  - Absolute paths outside stashDir are rejected
 *
 * Both paths are resolved to absolute paths before comparison.
 *
 * @param stashDir - The absolute path to the stash directory
 *                   (e.g. `/project/.saivage-work/tmp/stash`).
 * @param requestedPath - The file path requested by the caller.
 * @returns `true` if the path resolves inside stashDir, `false` otherwise.
 */
export function isStashPathAllowed(stashDir: string, requestedPath: string): boolean {
  if (!requestedPath || !stashDir) return false;

  // Resolve both to absolute paths
  const resolvedStash = resolve(stashDir);
  const resolvedRequested = resolve(stashDir, requestedPath);

  // Normalize trailing separator: both paths should have the same
  // trailing-sep treatment. We add a trailing sep to stashDir to
  // prevent prefix matches like /stash-foo when we mean /stash.
  const stashNorm = resolvedStash.endsWith(sep) ? resolvedStash : resolvedStash + sep;
  const reqNorm = resolvedRequested.endsWith(sep) ? resolvedRequested : resolvedRequested + sep;

  return reqNorm.startsWith(stashNorm);
}

// ── Safe File Access for Agents ───────────────────────────────

/**
 * Result from `getSafeFileForAgent()`.
 */
export interface SafeFileResult {
  /** Whether the file is entirely blocked. */
  blocked: boolean;
  /** The safe content (redacted if necessary, or original). */
  safeContent?: string;
  /** Human-readable reason if blocked or redacted. */
  reason?: string;
}

/**
 * Main API for file access checks from agents.
 *
 * This is called before an agent reads a file. It:
 *  1. Checks if the path is read-blocked → returns blocked:true
 *  2. Checks if the path needs secret redaction → returns redacted content
 *  3. Otherwise returns the content as-is
 *
 * @param filePath - Project-relative path to the file being read.
 * @param content  - The raw file content (only needed for redactable paths).
 * @returns A `SafeFileResult` describing what the agent should receive.
 */
export function getSafeFileForAgent(
  filePath: string,
  content: string,
): SafeFileResult {
  // 1. Check read-blocked
  if (isReadBlocked(filePath)) {
    return {
      blocked: true,
      reason: `Access to "${filePath}" is blocked for security reasons.`,
    };
  }

  // 2. Check if redaction is needed
  if (isRedacted(filePath)) {
    return {
      blocked: false,
      safeContent: redactSecrets(content),
      reason: `Secrets in "${filePath}" have been redacted.`,
    };
  }

  // 3. Safe — return content as-is
  return {
    blocked: false,
    safeContent: content,
  };
}
