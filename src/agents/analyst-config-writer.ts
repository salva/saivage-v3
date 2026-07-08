import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import type { ZodIssue } from 'zod';
import { writeFileAtomic } from '../persistence/index.js';
import { saivageConfigSchema } from './config-schema.js';
import type { SaivageConfig } from './config-schema.js';
import { redactAnalystSecretValue } from '../workspace/file-access-security.js';

export type ConfigWriteResult = { success: true; config: SaivageConfig; requires_restart?: boolean } | { success: false; fieldPath: string; message: string };

type RawConfig = Record<string, unknown>;
type ConfigDocument = YAML.Document.Parsed<YAML.ParsedNode, true>;
type PatchFn = (doc: ConfigDocument, raw: RawConfig) => ConfigWriteResult | void;

const locks = new Map<string, Promise<unknown>>();
const RUNTIME_KEYS = new Set(['continuous_improvement', 'max_review_retries', 'process_timeouts']);
const SERVER_KEYS = new Set(['port', 'host']);

function pointer(path: Array<string | number>): string { return path.map(String).join('/'); }
function zodFailure(issue: ZodIssue): ConfigWriteResult { return { success: false, fieldPath: pointer(issue.path), message: issue.message }; }
function configPath(projectRoot: string): string { return join(projectRoot, '.saivage', 'saivage.yaml'); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function documentObject(doc: ConfigDocument): RawConfig {
  const value = doc.toJS() as unknown;
  return isRecord(value) ? value : {};
}

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
    const doc = YAML.parseDocument(readFileSync(path, 'utf-8')) as ConfigDocument;
    const initialRaw = documentObject(doc);
    const early = patch(doc, initialRaw);
    if (early) return early;
    const raw = documentObject(doc);
    const parsed = saivageConfigSchema.safeParse(raw);
    if (!parsed.success) return zodFailure(parsed.error.issues[0]);
    writeFileAtomic(path, doc.toString());
    return { success: true, config: parsed.data, ...(requiresRestart ? { requires_restart: true } : {}) };
  });
}

export function setRoleRouting(projectRoot: string, role: string, modelCandidate: string): ConfigWriteResult {
  return readValidateWrite(projectRoot, (doc) => {
    doc.setIn(['models', 'routing', role], modelCandidate);
  });
}

export function setFailoverChain(projectRoot: string, forModel: string, orderedFailoverModels: string[]): ConfigWriteResult {
  return readValidateWrite(projectRoot, (doc) => {
    doc.setIn(['models', 'failover', forModel], orderedFailoverModels);
  });
}

export function mcpAdd(projectRoot: string, name: string, command: string, args?: string[], env?: Record<string, string>): ConfigWriteResult {
  return readValidateWrite(projectRoot, (doc, raw) => {
    const mcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    if (mcpServers[name]) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' already exists.` };
    doc.setIn(['mcpServers', name], { command, args: args ?? [], env: env ?? {}, transport: 'stdio', disabled: false, autostart: true });
  });
}

export function mcpEdit(projectRoot: string, name: string, patch: { command?: string; args?: string[]; env?: Record<string, string> }): ConfigWriteResult {
  return readValidateWrite(projectRoot, (doc, raw) => {
    const mcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    if (!isRecord(mcpServers[name])) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' is not configured.` };
    doc.setIn(['mcpServers', name], { ...(mcpServers[name] as RawConfig), ...patch });
  });
}

export function mcpRemove(projectRoot: string, name: string): ConfigWriteResult {
  return readValidateWrite(projectRoot, (doc, raw) => {
    const mcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    if (!mcpServers[name]) return { success: false, fieldPath: `mcpServers/${name}`, message: `MCP server '${name}' is not configured.` };
    doc.deleteIn(['mcpServers', name]);
  });
}

export function setRuntimeSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult {
  if (!RUNTIME_KEYS.has(key)) return { success: false, fieldPath: `runtime/${key}`, message: `Unknown runtime setting '${key}'.` };
  return readValidateWrite(projectRoot, (doc) => { doc.setIn(['runtime', key], value); });
}

export function setServerSetting(projectRoot: string, key: string, value: unknown): ConfigWriteResult {
  if (!SERVER_KEYS.has(key)) return { success: false, fieldPath: `server/${key}`, message: `Unknown server setting '${key}'.` };
  return readValidateWrite(projectRoot, (doc) => { doc.setIn(['server', key], value); }, key === 'port' || key === 'host');
}

export function getRedactedConfig(projectRoot: string): ConfigWriteResult {
  const raw = documentObject(YAML.parseDocument(readFileSync(configPath(projectRoot), 'utf-8')) as ConfigDocument);
  const parsed = saivageConfigSchema.safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error.issues[0]);
  return { success: true, config: redactAnalystSecretValue(parsed.data) as SaivageConfig };
}
