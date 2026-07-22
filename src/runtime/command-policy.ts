import { redactTextForOutbound } from '../redaction/index.js';

const SAFE_ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM']);
const SAFE_ENV_PREFIXES = ['LC_'];

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

export function sanitizedCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed = SAFE_ENV_ALLOWLIST.has(key) || SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed) {
      env[key] = value;
    }
  }
  return env;
}

export function redactCommandForPolicy(command: string): string {
  return redactTextForOutbound(command);
}
