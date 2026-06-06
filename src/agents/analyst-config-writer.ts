import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodIssue } from 'zod';
import { writeFileAtomic } from '../persistence/index.js';
import { saivageConfigSchema } from './config-schema.js';
import type { SaivageConfig } from './config-schema.js';
import { redactAnalystSecretValue } from '../workspace/file-access-security.js';

export type ConfigWriteResult = { success: true; config: SaivageConfig; requires_restart?: boolean } | { success: false; fieldPath: string; message: string };

type RawConfig = Record<string, unknown>;
type PatchFn = (raw: RawConfig) => ConfigWriteResult | void;

const locks = new Map<string, Promise<unknown>>();
const RUNTIME_KEYS = new Set(['continuous_improvement', 'max_review_retries', 'process_timeouts']);
const SERVER_KEYS = new Set(['port', 'host']);

function pointer(path: Array<string | number>): string { return path.map(String).join('/'); }
function zodFailure(issue: ZodIssue): ConfigWriteResult { return { success: false, fieldPath: pointer(issue.path), message: issue.message }; }
function configPath(projectRoot: string): string { return join(projectRoot, '.saivage', 'saivage.json'); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function ensureRecord(parent: RawConfig, key: string): RawConfig { if (!isRecord(parent[key])) parent[key] = {}; return parent[key] as RawConfig; }

function withProjectLock<T>(projectRoot: string, work: () => T): T {
  const previous = locks.get(projectRoot);
  if (previous) {
    return { success: false, fieldPath: '/', message: 'Configuration write already in progress for this project.' } as T;
  }
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(projectRoot, current);
  try { return work(); }
  finally {
    release();
    if (locks.get(projectRoot) === current) locks.delete(projectRoot);
  }
}

function readValidateWrite(projectRoot: string, patch: PatchFn, requiresRestart = false): ConfigWriteResult {
  return withProjectLock(projectRoot, () => {
    const path = configPath(projectRoot);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as RawConfig;
    const early = patch(raw);
    if (early) return early;
    const parsed = saivageConfigSchema.safeParse(raw);
    if (!parsed.success) return zodFailure(parsed.error.issues[0]);
    writeFileAtomic(path, JSON.stringify(raw, null, 2) + '\n');
    return { success: true, config: parsed.data, ...(requiresRestart ? { requires_restart: true } : {}) };
  });
}

export function setRoleRouting(projectRoot: string, role: string, modelCandidate: string): ConfigWriteResult {
  return readValidateWrite(projectRoot, (raw) => {
    const models = ensureRecord(raw, 'models');
    const routing = ensureRecord(models, 'routing');
    routing[role] = modelCandidate;
  });
}

export function setFailoverChain(projectRoot: string, forModel: string, orderedFailoverModels: string[]): ConfigWriteResult {
  return readValidateWrite(projectRoot, (raw) => {
    const models = ensureRecord(raw, 'models');
    const failover = ensureRecord(models, 'failover');
    failover[forModel] = orderedFailoverModels;
  });
}

export function mcpAdd(projectRoot: string, name: string, command: string, args?: string[], env?: Record<string, string>): ConfigWriteResult {
  return readValidateWrite(projectRoot, (raw) => {
    const mcpServers = ensureRecord(raw, 'mcpServers');
    if (mcpServers[name]) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' already exists.` };
    mcpServers[name] = { command, args: args ?? [], env: env ?? {}, transport: 'stdio', disabled: false, autostart: true };
  });
}

export function mcpEdit(projectRoot: string, name: string, patch: { command?: string; args?: string[]; env?: Record<string, string> }): ConfigWriteResult {
  return readValidateWrite(projectRoot, (raw) => {
    const mcpServers = ensureRecord(raw, 'mcpServers');
    if (!isRecord(mcpServers[name])) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' is not configured.` };
    mcpServers[name] = { ...(mcpServers[name] as RawConfig), ...patch };
  });
}

export function mcpRemove(projectRoot: string, name: string): ConfigWriteResult {
  return readValidateWrite(projectRoot, (raw) => {
    const mcpServers = ensureRecord(raw, 'mcpServers');
    if (!mcpServers[name]) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' is not configured.` };
    delete mcpServers[name];
  });
}

export function setRuntimeSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult {
  if (!RUNTIME_KEYS.has(key)) return { success: false, fieldPath: `runtime/${key}`, message: `Unknown runtime setting '${key}'.` };
  return readValidateWrite(projectRoot, (raw) => { ensureRecord(raw, 'runtime')[key] = value; });
}

export function setServerSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult {
  if (!SERVER_KEYS.has(key)) return { success: false, fieldPath: `server/${key}`, message: `Unknown server setting '${key}'.` };
  return readValidateWrite(projectRoot, (raw) => { ensureRecord(raw, 'server')[key] = value; }, key === 'port' || key === 'host');
}

export function getRedactedConfig(projectRoot: string): ConfigWriteResult {
  const raw = JSON.parse(readFileSync(configPath(projectRoot), 'utf-8')) as RawConfig;
  const parsed = saivageConfigSchema.safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error.issues[0]);
  return { success: true, config: redactAnalystSecretValue(parsed.data) as SaivageConfig };
}
