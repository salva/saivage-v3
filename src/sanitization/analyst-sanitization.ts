import { basename, resolve } from 'node:path';
import { redactTextForOutbound } from '../redaction/index.js';
import { looksLikeSecretPath } from '../workspace/index.js';

const MAX_ACTIVITY_TEXT = 200;
const SECRET_PATH_TOKEN = '[SECRET_PATH]';
const SECRET_ASSIGNMENT_RE = /\b(?:api[_-]?key|token|secret|password|authorization|cookie|credential)s?\s*=\s*([^\s]+)/gi;
const SECRET_PATH_SEGMENT_RE = /(?<!\[SECRET_PATH\])(?:[A-Za-z]:)?(?:[^\s"'`;,|()<>\]]*\/)?(?:\.saivage\/auth-profiles\.json|auth-profiles\.json|\.env(?:\.[A-Za-z0-9_-]+)?)(?![A-Za-z0-9_.-])/gi;
const ABSOLUTE_PATH_RE = /(?<![A-Za-z0-9_.-])((?:[A-Za-z]:)?(?:\/[^\s"'`;,|()<>\]]+)+)/g;

function clamp(value: string, max = MAX_ACTIVITY_TEXT): string {
  if (value.length <= max) return value;
  const secretIndex = value.indexOf(SECRET_PATH_TOKEN);
  if (secretIndex >= 0) {
    const tokenEnd = secretIndex + SECRET_PATH_TOKEN.length;
    if (tokenEnd <= max) return `${value.slice(0, max - 1)}…`;
    const end = Math.min(value.length, Math.max(max, tokenEnd));
    const start = Math.max(0, end - max);
    return value.slice(start, end);
  }
  return `${value.slice(0, max - 1)}…`;
}

export function sanitizeAnalystText(value: string, max = MAX_ACTIVITY_TEXT): string {
  if (!value) return '';
  let sanitized: string = redactTextForOutbound(value);
  sanitized = sanitized.replace(SECRET_ASSIGNMENT_RE, (match, rawValue) => {
    const replacement = looksLikeSecretPath(rawValue) ? SECRET_PATH_TOKEN : '[REDACTED]';
    return match.replace(rawValue, replacement);
  });
  sanitized = sanitized.replace(SECRET_PATH_SEGMENT_RE, SECRET_PATH_TOKEN);
  sanitized = sanitized.replace(ABSOLUTE_PATH_RE, (_full, match) => {
    try {
      return looksLikeSecretPath(resolve(match)) || looksLikeSecretPath(basename(match)) ? SECRET_PATH_TOKEN : match;
    } catch {
      return looksLikeSecretPath(match) ? SECRET_PATH_TOKEN : match;
    }
  });
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  return clamp(sanitized, max);
}
