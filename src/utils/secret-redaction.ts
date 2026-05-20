export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

export const SECRET_KEY_PATTERN =
  /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password|credential|credentials?|cookie|set-cookie|auth)\b/i;

const JSON_SECRET_VALUE_RE =
  /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;

const ESCAPED_JSON_SECRET_VALUE_RE = /(\\")([^"\\]+)(\\")(\s*:\s*)(\\")([^"\\]*)(\\")/gi;

const INLINE_SECRET_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_-]*(?:(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[A-Za-z0-9_-]*)?)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

const CREDENTIAL_LITERAL_RE = /\b(sk-[^\s"\\]+|tid=[^\s"\\]+|ghu_[A-Za-z0-9_]+|rt_[^\s"\\]+|tok_[^\s"\\]+)\b/g;

const BEARER_CREDENTIAL_RE = /\b(Bearer\s+)([^\s"\\]+)/gi;

const URL_SECRET_QUERY_PARAM_RE =
  /([?&][^=&#\s]*(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[^=&#\s]*=)([^&#\s]+)/gi;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function shouldPreserveValue(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

function redactCredentialMatch(match: string): string {
  const prefix = match.startsWith('sk-') ? 'sk' :
    match.startsWith('tid=') ? 'tid' :
      match.startsWith('ghu_') ? 'ghu' :
        match.startsWith('rt_') ? 'rt' :
          match.startsWith('tok_') ? 'tok' : 'credential';
  return `${prefix}-${SECRET_REDACTION_PLACEHOLDER}`;
}

export function redactCredentialLiterals(content: string): string {
  if (!content) return content;
  return content
    .replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch)
    .replace(BEARER_CREDENTIAL_RE, (_match, prefix: string) => {
      return `${prefix}${SECRET_REDACTION_PLACEHOLDER}`;
    });
}

export function redactJsonSecretValues(content: string): string {
  if (!content) return content;

  return content.replace(JSON_SECRET_VALUE_RE, (_match, keyPart, wsBefore, wsAfter, valuePart) => {
    const keyInner = keyPart.slice(1, -1);

    if (!isSecretKey(keyInner) || shouldPreserveValue(valuePart)) {
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    return `${keyPart}${wsBefore}:${wsAfter}"${SECRET_REDACTION_PLACEHOLDER}"`;
  });
}

export function redactEscapedJsonSecretValues(content: string): string {
  if (!content) return content;

  return content.replace(
    ESCAPED_JSON_SECRET_VALUE_RE,
    (match, keyOpen: string, key: string, keyClose: string, separator: string, valueOpen: string, secretValue: string, valueClose: string) => {
      if (!isSecretKey(key) || shouldPreserveValue(secretValue)) {
        return match;
      }
      return `${keyOpen}${key}${keyClose}${separator}${valueOpen}${SECRET_REDACTION_PLACEHOLDER}${valueClose}`;
    },
  );
}

export function redactInlineSecretAssignments(content: string): string {
  if (!content) return content;
  return content
    .replace(INLINE_SECRET_ASSIGNMENT_RE, (match, key: string) => {
      if (!isSecretKey(key)) return match;
      return `${key}=${SECRET_REDACTION_PLACEHOLDER}`;
    })
    .replace(URL_SECRET_QUERY_PARAM_RE, (_match, prefix: string) => {
      return `${prefix}${SECRET_REDACTION_PLACEHOLDER}`;
    });
}

export function redactSecrets(content: string): string {
  if (!content) return content;
  return redactCredentialLiterals(redactJsonSecretValues(content));
}

export function redactProviderLikeText(content: string): string {
  if (!content) return content;
  return redactInlineSecretAssignments(redactEscapedJsonSecretValues(redactSecrets(content)));
}
