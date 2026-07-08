#!/usr/bin/env node
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as YAML from 'yaml';
import { evaluateAuthz } from './agents/tool-api.js';
import { startApp } from './boot/index.js';
import { recordControlAction, stableStringify, initProjectTree, isInitialized, findProjectRoot } from './persistence/index.js';
import { isLocked, pauseRuntimeControl, resumeRuntimeControl } from './runtime/control-api.js';
import { readRuntimeState } from './runtime/state-api.js';
import { readLiveLockHolder } from './runtime/control-api.js';
import { deriveCurrentCardId } from './runtime/current-run.js';

interface CliOptions { force?: boolean; port?: string; host?: string; }
const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--force]
  saivage start [--port <port>] [--host <host>]
  saivage status
  saivage pause
  saivage resume
  saivage reset
      Remove .saivage/cards, .saivage/runtime, and .saivage/notes.
      Preserves credentials and project files such as .saivage/auth-profiles.json,
      .saivage/project.json, .saivage/saivage.yaml, and research/future-objectives.
      Refuses while the runtime lockfile is present.
  saivage help
`;
function parseCommand(rawArgs: string[]): { command: string; options: CliOptions } { const args = rawArgs.slice(2); if (args.length === 0) return { command: 'help', options: {} }; const command = args[0]!; const rest = args.slice(1); let options: CliOptions = {}; if (rest.length > 0) { const parsed = parseArgs({ args: rest, options: { force: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' } }, allowPositionals: false, strict: true }); options = parsed.values as CliOptions; } return { command, options }; }
async function handleInit(options: CliOptions): Promise<void> { const projectRoot = process.cwd(); if (!options.force && isInitialized(projectRoot)) { console.log(`Project already initialized at ${projectRoot}`); return; } initProjectTree(projectRoot); console.log(`Project initialized at ${projectRoot}`); }
async function handleStart(_options: CliOptions, args: string[]): Promise<void> { const app = await startApp({ argv: args }); console.log(`Saivage server listening on http://${app.environment.server.host}:${app.environment.server.port}`); }
async function handleStatus(): Promise<void> { const projectRoot = findProjectRoot(); if (projectRoot === null) { console.log('Not in a Saivage project'); return; } const state = readRuntimeState(projectRoot); if (state === null) { console.log(`Project root: ${projectRoot}`); console.log('Runtime state: not initialized (no state.json)'); return; } const holder = readLiveLockHolder(projectRoot); console.log(`Project root: ${projectRoot}`); console.log(`Status:       ${state.status}`); console.log(`PID:          ${holder ? holder.pid : '(not running)'}`); console.log(`Current card: ${deriveCurrentCardId(state) ?? '(none)'}`); console.log(`Started at:   ${state.started_at}`); }
async function restBaseUrl(projectRoot: string): Promise<string> { const cfgPath = join(projectRoot, '.saivage', 'saivage.yaml'); let host = '127.0.0.1'; let port = 8080; if (existsSync(cfgPath)) { try { const cfg = YAML.parse(readFileSync(cfgPath, 'utf-8')) as { server?: { host?: string; port?: number } }; host = cfg.server?.host === '0.0.0.0' ? '127.0.0.1' : (cfg.server?.host ?? host); port = cfg.server?.port ?? port; } catch { void 0; } } return `http://${host}:${port}`; }
async function mutateRuntimeViaCli(projectRoot: string, action: 'pause' | 'resume'): Promise<void> { const verdict = evaluateAuthz({ actor: 'user', surface: 'cli', safety_class: 'low' }); if (verdict === 'deny') { recordControlAction(projectRoot, { actor: 'user', surface: 'cli', action: `runtime.${action}`, target_kind: 'runtime', target_id: 'project', params_summary: stableStringify({ action }), outcome: 'denied', outcome_summary: 'authz denied' }); throw new Error('Denied by authorization policy.'); }
  if (isLocked(projectRoot)) {
    const base = await restBaseUrl(projectRoot);
    const token = process.env['SAIVAGE_API_TOKEN'];
    const res = await fetch(`${base}/api/runtime/${action}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    const body = await res.text();
    if (!res.ok) throw new Error(body);
    console.log(body);
    return;
  }
  const result = action === 'pause' ? pauseRuntimeControl({ projectRoot }) : resumeRuntimeControl({ projectRoot });
  recordControlAction(projectRoot, { actor: 'user', surface: 'cli', action: `runtime.${action}`, target_kind: 'runtime', target_id: 'project', params_summary: stableStringify({ action, liveRuntimeUpdated: false }), outcome: result.ok ? 'ok' : 'error', outcome_summary: result.ok ? 'persisted-only mutation applied (server not running)' : (result.message ?? result.error ?? 'mutation failed'), ...(result.ok ? {} : { error: result.message ?? result.error ?? 'mutation failed' }) });
  if (!result.ok) throw new Error(result.message ?? result.error ?? `Failed to ${action} runtime`);
  console.log(`Notice: server not running; updated persisted runtime state only.`);
}
async function handleResume(): Promise<void> { await mutateRuntimeViaCli(process.cwd(), 'resume'); }
async function handlePause(): Promise<void> { await mutateRuntimeViaCli(process.cwd(), 'pause'); }
async function handleReset(): Promise<void> { const projectRoot = process.cwd(); if (isLocked(projectRoot)) throw new Error('Cannot reset while the server/runtime lockfile is present. Stop the server and try again.'); const targets = ['cards', 'runtime', 'notes'].map((name) => join(projectRoot, '.saivage', name)); console.log('Reset will remove:'); for (const target of targets) console.log(`- ${target}`); for (const target of targets) if (existsSync(target)) rmSync(target, { recursive: true, force: true }); }
function handleHelp(): void { console.log(USAGE); }
export async function run(args: string[]): Promise<void> { const { command, options } = parseCommand(args); switch (command) { case 'init': await handleInit(options); break; case 'start': await handleStart(options, args); break; case 'status': await handleStatus(); break; case 'resume': await handleResume(); break; case 'pause': await handlePause(); break; case 'reset': await handleReset(); break; case 'help': case '--help': case '-h': handleHelp(); break; default: throw new Error(`Unknown command: ${command}`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { run(process.argv).catch((err: unknown) => { console.error(`Fatal error: ${(err as Error).message}`); process.exit(1); }); }
