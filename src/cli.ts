#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as YAML from 'yaml';
import { evaluateAuthz } from './agents/tool-api.js';
import { startApp } from './boot/index.js';
import { newProjectRootInput } from './boot/app.js';
import { stableStringify, isInitialized, findProjectRoot } from './persistence/index.js';
import { classifyPersistenceOpenMode, createProjectStoreRepository } from './persistence/project-store-repository.js';
import { isLocked } from './runtime/control-api.js';
import { readRuntimeState } from './runtime/state-api.js';
import { RuntimeStateStore } from './runtime/state.js';
import { deriveCurrentCardId } from './runtime/current-run.js';
import { readRuntimeLockStatus } from './runtime/lock.js';
import { runtimeProcessLockFile } from './persistence/layout.js';
import { withDirectMutationComposition } from './boot/direct-mutation-composition.js';
import { AppLogStore } from './persistence/app-log.js';
import { RuntimeControlService } from './application/runtime-control-service.js';
import { RuntimeInterventionBinding } from './application/intervention-readiness.js';

interface CliOptions { force?: boolean; port?: string; host?: string; config?: string; 'project-root'?: string; 'create-runtime'?: boolean; }
const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--force]
  saivage start [--port <port>] [--host <host>] [--project-root <path>] [--create-runtime]
  saivage status
  saivage pause
  saivage resume
  saivage reset
      Atomically acquires .saivage/locks/runtime.lock, refuses while a valid
      live runtime owns it regardless of lock age, and fails closed without
      deletion if an existing lock cannot be read. It removes generated roots
      .saivage/cards, .saivage/agents, .saivage/state, .saivage/logs,
      .saivage/locks contents except the held runtime.lock, .saivage/work,
      optional .saivage/stages, and obsolete old roots .saivage/runtime,
      .saivage/tmp, .saivage/archive, .saivage/supervision, .saivage/notes,
      .saivage/outputs, .saivage/views, and the external .saivage-work/ root.
       Every existing lock blocks reset. After verifying no Saivage process owns
       the project, remove an abandoned lock path manually and retry. Reset then recreates the empty current layout,
      default runtime state, empty
      app log, lock namespace, and root project card before releasing the lock.
      Preserves durable credentials/config/operator inputs such as
      .saivage/auth-profiles.json, .saivage/saivage.yaml,
      .saivage/project.json, .saivage/config/prompts/,
      .saivage/skills/index.json, .saivage/instructions/, and target source/docs.
  saivage help
`;
function parseCommand(rawArgs: string[]): { command: string; options: CliOptions } { const args = rawArgs.slice(2); if (args.length === 0) return { command: 'help', options: {} }; const command = args[0]!; const rest = args.slice(1); let options: CliOptions = {}; if (rest.length > 0) { const parsed = parseArgs({ args: rest, options: { force: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' }, config: { type: 'string' }, 'project-root': { type: 'string' }, 'create-runtime': { type: 'boolean' } }, allowPositionals: false, strict: true }); options = parsed.values as CliOptions; } return { command, options }; }
async function handleInit(options: CliOptions): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'init', (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    if (!options.force && isInitialized(canonicalProjectRoot)) { console.log(`Project already initialized at ${canonicalProjectRoot}`); return; }
    if (composition.projectIdentity.read() === null) composition.createAndBindProjectIdentity();
    const mode = classifyPersistenceOpenMode(canonicalProjectRoot, newProjectRootInput(canonicalProjectRoot));
    createProjectStoreRepository({ projectRoot: canonicalProjectRoot, persistenceHealth: composition.persistenceHealth, mode });
    console.log(`Project initialized at ${canonicalProjectRoot}`);
  });
}
async function handleStart(_options: CliOptions, args: string[]): Promise<void> { const app = await startApp({ argv: args }); console.log(`Saivage server listening on http://${app.environment.server.host}:${app.environment.server.port}`); }
async function handleStatus(): Promise<void> { const projectRoot = findProjectRoot(); if (projectRoot === null) { console.log('Not in a Saivage project'); return; } const state = readRuntimeState(projectRoot); const lock = readRuntimeLockStatus(projectRoot); if (state === null) { console.log(`Project root: ${projectRoot}`); console.log('Runtime state: not initialized (missing runtime state file .saivage/state/runtime.json)'); } else { console.log(`Project root: ${projectRoot}`); console.log(`Status:       ${state.status}`); console.log(`Current card: ${deriveCurrentCardId(state) ?? '(none)'}`); console.log(`Started at:   ${state.started_at}`); } if (lock.kind === 'missing') console.log('Runtime lock: not present'); else { console.log(`Runtime lock: ${lock.kind.replace('_', '/')}`); console.log(`PID:          ${lock.kind === 'malformed_unreadable' ? '(unknown)' : lock.record.pid}`); if (lock.kind !== 'live') console.log(lock.repairInstruction); } }
async function restBaseUrl(projectRoot: string): Promise<string> { const cfgPath = join(projectRoot, '.saivage', 'saivage.yaml'); let host = '127.0.0.1'; let port = 8080; if (existsSync(cfgPath)) { try { const cfg = YAML.parse(readFileSync(cfgPath, 'utf-8')) as { server?: { host?: string; port?: number } }; host = cfg.server?.host === '0.0.0.0' ? '127.0.0.1' : (cfg.server?.host ?? host); port = cfg.server?.port ?? port; } catch { void 0; } } return `http://${host}:${port}`; }
async function mutateRuntimeViaCli(projectRoot: string, action: 'pause' | 'resume'): Promise<void> { const verdict = evaluateAuthz({ actor: 'user', surface: 'cli', safety_class: 'low' }); if (verdict === 'deny') throw new Error('Denied by authorization policy.');
  if (isLocked(projectRoot)) {
    const base = await restBaseUrl(projectRoot);
    const token = process.env['SAIVAGE_API_TOKEN'];
    const res = await fetch(`${base}/api/runtime/${action}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    const body = await res.text();
    if (!res.ok) throw new Error(body);
    console.log(body);
    return;
  }
  const result = withDirectMutationComposition(projectRoot, 'bound', (composition) => {
    const runtimeState = new RuntimeStateStore(projectRoot, composition.persistenceHealth);
    runtimeState.restabilize();
    const appLogs = new AppLogStore(projectRoot, composition.persistenceHealth);
    appLogs.restabilize();
    const runtimeControl = new RuntimeControlService({ projectRoot, persistenceHealth: composition.persistenceHealth, interventionBinding: new RuntimeInterventionBinding(), runtimeState, appLogs });
    const request = { actor: 'user' as const, surface: 'cli' as const, paramsSummary: stableStringify({ action, liveRuntimeUpdated: false }) };
    const controlResult = action === 'pause' ? runtimeControl.pauseOffline(request) : runtimeControl.resumeOffline(request);
    return controlResult;
  });
  if (!result.ok) throw new Error(result.message ?? result.error ?? `Failed to ${action} runtime`);
  console.log(`Notice: server not running; updated persisted runtime state only.`);
}
async function handleResume(): Promise<void> { await mutateRuntimeViaCli(process.cwd(), 'resume'); }
async function handlePause(): Promise<void> { await mutateRuntimeViaCli(process.cwd(), 'pause'); }
function removeIfPresent(path: string): void { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); }
function removeLockEntriesExceptHeldRuntime(projectRoot: string): void {
  const locksRoot = join(projectRoot, '.saivage', 'locks');
  if (!existsSync(locksRoot)) return;
  const held = runtimeProcessLockFile(projectRoot);
  for (const entry of readdirSync(locksRoot)) {
    const path = join(locksRoot, entry);
    if (path === held) continue;
    removeIfPresent(path);
  }
}
async function handleReset(): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'bound', (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const generatedRoots = ['cards', 'agents', 'state', 'logs', 'work', 'stages'].map((name) => join(canonicalProjectRoot, '.saivage', name));
    const obsoleteRoots = ['runtime', 'tmp', 'archive', 'supervision', 'notes', 'outputs', 'views'].map((name) => join(canonicalProjectRoot, '.saivage', name));
    const externalGeneratedRoots = [join(canonicalProjectRoot, '.saivage-work')];
    console.log('Reset will remove generated runtime roots, external generated roots, and obsolete old roots, then reinitialize the current empty layout:');
    for (const target of [...generatedRoots, join(canonicalProjectRoot, '.saivage', 'locks', '* except runtime.lock while held'), ...obsoleteRoots, ...externalGeneratedRoots]) console.log(`- ${target}`);
    for (const target of generatedRoots) removeIfPresent(target);
    removeLockEntriesExceptHeldRuntime(canonicalProjectRoot);
    for (const target of obsoleteRoots) removeIfPresent(target);
    for (const target of externalGeneratedRoots) removeIfPresent(target);
    createProjectStoreRepository({ projectRoot: canonicalProjectRoot, persistenceHealth: composition.persistenceHealth, mode: { kind: 'bootstrap', root: newProjectRootInput(canonicalProjectRoot) } });
    console.log('Project reset and reinitialized with an empty current layout and root project card. Durable credentials, config, prompt overrides, skills, instructions, and source/docs were preserved.');
  });
}
function handleHelp(): void { console.log(USAGE); }
export async function run(args: string[]): Promise<void> { const { command, options } = parseCommand(args); switch (command) { case 'init': await handleInit(options); break; case 'start': await handleStart(options, args); break; case 'status': await handleStatus(); break; case 'resume': await handleResume(); break; case 'pause': await handlePause(); break; case 'reset': await handleReset(); break; case 'help': case '--help': case '-h': handleHelp(); break; default: throw new Error(`Unknown command: ${command}`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { run(process.argv).catch((err: unknown) => { console.error(`Fatal error: ${(err as Error).message}`); process.exit(1); }); }
