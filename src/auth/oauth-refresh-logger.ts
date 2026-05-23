import { redactSnippetForOutbound, redactTextForOutbound } from '../redaction/index.js';

const PREFIX = '[oauth-profiles]';
const DEFAULT_SNIPPET_LENGTH = 500;
const OAUTH_CONTEXT = { sink: 'console' as const, source: 'oauth-refresh-logger' };

function safeDynamicText(value: unknown): string {
  return redactTextForOutbound(value, 'provider.diagnostic', OAUTH_CONTEXT);
}

function snippet(value: unknown, maxLength = DEFAULT_SNIPPET_LENGTH): string {
  return redactSnippetForOutbound(value, 'provider.diagnostic', maxLength, OAUTH_CONTEXT);
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
