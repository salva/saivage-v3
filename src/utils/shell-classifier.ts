import { resolve } from 'node:path';
import { looksLikeSecretPath } from './file-access-security.js';

export type ShellSafetyClass = 'read_only' | 'low' | 'destructive';

export const READ_ONLY_HEADS = new Set([
  'ls', 'cat', 'head', 'tail', 'stat', 'pwd', 'whoami', 'id', 'hostname', 'uname',
  'grep', 'rg', 'find', 'ps', 'df', 'du', 'free', 'top', 'uptime',
  'journalctl', 'systemctl', 'curl', 'wget', 'git', 'sha256sum', 'md5sum',
  'wc', 'cut', 'awk', 'sed', 'node', 'python', 'python3', 'tsc',
]);

export const DESTRUCTIVE_HEADS = new Set([
  'rm', 'rmdir', 'dd', 'mkfs', 'mkswap', 'shred', 'wipefs',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'iptables', 'ip6tables', 'nft', 'ufw',
  'mount', 'umount', 'swapoff', 'swapon',
  'chown', 'chgrp', 'sudo', 'doas', 'su',
  'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk',
]);

const SYSTEM_PATHS = ['/etc', '/usr', '/var', '/boot', '/lib', '/root'];
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const VERSION_ARG_RE = /^--version$|^-V$|^-v$/;
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

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === 'double') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'") {
      quote = 'single';
      continue;
    }

    if (ch === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|') || (ch === '>' && next === '>')) {
      pushCurrent();
      tokens.push(ch + next);
      i += 1;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '>') {
      pushCurrent();
      tokens.push(ch);
      continue;
    }

    current += ch;
  }

  if (escaped) current += '\\';
  pushCurrent();
  return tokens;
}

function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === ';' || token === '&&' || token === '||' || token === '|') {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function isSystemPath(target: string): boolean {
  return SYSTEM_PATHS.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))
    || /\/home\/[^/]+\/.ssh(?:\/|$)/.test(target);
}

function isSafeCurlUrl(url: string): boolean {
  return /^https?:\/\/.+\/health(?:[/?#].*)?$/.test(url);
}

function isReadOnlyGit(tokens: string[]): boolean {
  const args = tokens[0] === 'git' ? tokens.slice(1) : [];
  const filtered = args.filter((arg) => arg !== '--no-pager');
  const head = filtered[0];
  return head !== undefined && ['log', 'status', 'diff', 'show', 'branch'].includes(head)
    || (head === 'remote' && filtered[1] === '-v');
}

function isReadOnlyFind(tokens: string[]): boolean {
  return !tokens.includes('-exec') && !tokens.includes('-delete');
}

function isReadOnlySystemctl(tokens: string[]): boolean {
  return tokens[1] === 'is-active' || tokens[1] === 'status';
}

function isReadOnlyJournalctl(tokens: string[]): boolean {
  return tokens.includes('--no-pager');
}

function isReadOnlyTop(tokens: string[]): boolean {
  return tokens.includes('-bn1');
}

function isReadOnlySed(tokens: string[]): boolean {
  return tokens.includes('-n') && !tokens.includes('-i');
}

function isReadOnlyVersion(tokens: string[]): boolean {
  return tokens.length >= 2 && tokens.slice(1).some((token) => VERSION_ARG_RE.test(token));
}

function classifyHead(head: string, tokens: string[]): ShellSafetyClass {
  if (DESTRUCTIVE_HEADS.has(head)) return 'destructive';
  if (!READ_ONLY_HEADS.has(head)) return 'low';

  switch (head) {
    case 'curl':
      return tokens.some(isSafeCurlUrl) ? 'read_only' : 'low';
    case 'wget': {
      const url = tokens.find((token) => /^https?:\/\//.test(token));
      return tokens.includes('-qO-') && url && isSafeCurlUrl(url) ? 'read_only' : 'low';
    }
    case 'find':
      return isReadOnlyFind(tokens) ? 'read_only' : 'destructive';
    case 'git':
      return isReadOnlyGit(tokens) ? 'read_only' : 'destructive';
    case 'systemctl':
      return isReadOnlySystemctl(tokens) ? 'read_only' : 'destructive';
    case 'journalctl':
      return isReadOnlyJournalctl(tokens) ? 'read_only' : 'low';
    case 'top':
      return isReadOnlyTop(tokens) ? 'read_only' : 'low';
    case 'sed':
      return isReadOnlySed(tokens) ? 'read_only' : 'destructive';
    case 'node':
    case 'python':
    case 'python3':
    case 'tsc':
      return isReadOnlyVersion(tokens) ? 'read_only' : 'low';
    default:
      return 'read_only';
  }
}

function classifySegment(tokens: string[], cwd: string): ShellSafetyClass {
  if (tokens.length === 0) return 'read_only';
  const joined = tokens.join(' ');
  if (joined.includes('rm -rf') || joined.includes('rm -fr')) return 'destructive';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ((token === '>' || token === '>>') && i + 1 < tokens.length) {
      const target = resolve(cwd, tokens[i + 1]);
      if (isSystemPath(target)) return 'destructive';
    }
    if (!token.startsWith('-')) {
      const resolved = resolve(cwd, token);
      if (looksLikeSecretPath(resolved)) return 'destructive';
    }
  }

  let headIndex = 0;
  while (headIndex < tokens.length && ENV_PREFIX_RE.test(tokens[headIndex])) headIndex += 1;
  const head = tokens[headIndex];
  if (!head) return 'read_only';

  if (head === 'kill' && tokens.includes('-9') && tokens.includes('1')) return 'destructive';
  if (head === 'chmod' && tokens.includes('-R')) return 'destructive';
  if (head === 'pip' && tokens[headIndex + 1] === 'install') return 'destructive';
  if (head === 'npm' && (tokens[headIndex + 1] === 'install' || tokens[headIndex + 1] === 'ci')) return 'destructive';

  return classifyHead(head, tokens.slice(headIndex));
}

export function classifyShellCommand(command: string, cwd: string): ShellSafetyClass {
  const tokens = tokenizeShell(command);
  const segments = splitSegments(tokens);
  let sawLow = false;

  for (const segment of segments) {
    const verdict = classifySegment(segment, cwd);
    if (verdict === 'destructive') return 'destructive';
    if (verdict === 'low') sawLow = true;
  }

  return sawLow ? 'low' : 'read_only';
}

export function sanitizedEnv(): NodeJS.ProcessEnv {
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
