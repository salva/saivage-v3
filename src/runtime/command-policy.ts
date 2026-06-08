import { redactTextForOutbound } from '../redaction/index.js';

const SAFE_ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM']);
const SAFE_ENV_PREFIXES = ['LC_'];
const SECRET_ENV_PATTERNS = [
  /^SAIVAGE_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^GOOGLE_/,
  /^AZURE_/,
  /^TELEGRAM_/,
  /_TOKEN$/,
  /_KEY$/,
  /_SECRET$/,
  /_PASSWORD$/,
];

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const MAX_ANALYST_OUTPUT_BYTES = 1_048_576;

export function sanitizedCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed = SAFE_ENV_ALLOWLIST.has(key) || SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed) {
      env[key] = value;
      continue;
    }
    if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
  }
  return env;
}

export function redactCommandForPolicy(command: string): string {
  return redactTextForOutbound(command, 'operator.api', { source: 'command-policy.command' });
}

export function truncateCommandOutput(value: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
}
