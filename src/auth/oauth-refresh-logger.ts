import { redactProviderLikeText } from '../utils/secret-redaction.js';

const PREFIX = '[oauth-profiles]';
const REDACTION_CONVERSION_FAILURE = '[unserializable dynamic value]';
const DEFAULT_SNIPPET_LENGTH = 500;

function rawDynamicText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  try {
    if (typeof value === 'object') {
      const json = JSON.stringify(value);
      return json ?? REDACTION_CONVERSION_FAILURE;
    }

    return String(value);
  } catch {
    return REDACTION_CONVERSION_FAILURE;
  }
}

function safeDynamicText(value: unknown): string {
  return redactProviderLikeText(rawDynamicText(value));
}

function snippet(value: unknown, maxLength = DEFAULT_SNIPPET_LENGTH): string {
  return safeDynamicText(value).slice(0, maxLength);
}

interface RefreshNameContext {
  name: string;
}

export function logOAuthRefreshStart({
  name,
  tokenEndpoint,
}: RefreshNameContext & { tokenEndpoint: string }): void {
  console.error(
    `${PREFIX} Refreshing token for '${safeDynamicText(name)}' at ${safeDynamicText(tokenEndpoint)}...`,
  );
}

export function logOAuthRefreshHttpFailure({
  name,
  status,
  body,
}: RefreshNameContext & { status: number; body: unknown }): void {
  console.error(
    `${PREFIX} Token refresh failed for '${safeDynamicText(name)}' (HTTP ${status}): ${snippet(body)}`,
  );
}

export function logOAuthRefreshMissingAccessToken({
  name,
  response,
}: RefreshNameContext & { response: unknown }): void {
  console.error(
    `${PREFIX} Token refresh response for '${safeDynamicText(name)}' is missing access_token. ` +
      `Response: ${snippet(response)}`,
  );
}

export function logOAuthRefreshException({
  name,
  error,
}: RefreshNameContext & { error: unknown }): void {
  console.error(
    `${PREFIX} Token refresh failed for '${safeDynamicText(name)}': ${safeDynamicText(error)}`,
  );
}
