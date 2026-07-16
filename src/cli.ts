#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { startApp } from './boot/index.js';
import { newProjectRootInput } from './boot/app.js';
import { isInitialized, findProjectRoot } from './persistence/index.js';
import { readRuntimeLockStatus } from './runtime/lock.js';
import { runtimeProcessLockFile } from './persistence/layout.js';
import { withDirectMutationComposition } from './boot/direct-mutation-composition.js';
import { publishInitialProjectCard, readCard } from './persistence/card-files.js';
import { readProjectIdentity } from './persistence/project-identity.js';
import { OperatorRuntimeHttpClient } from './application/operator-runtime-http-client.js';

interface CliOptions { force?: boolean; port?: string; host?: string; config?: string; 'project-root'?: string; 'create-runtime'?: boolean; }
const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--force]
  saivage start [--port <port>] [--host <host>] [--project-root <path>] [--create-runtime]
  saivage status
  saivage pause
  saivage resume
  saivage stop
  saivage restart_server
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
       lock namespace and root project card before releasing the lock.
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
    if (readProjectIdentity(canonicalProjectRoot) === null) composition.createAndBindProjectIdentity();
    if (readCard(canonicalProjectRoot, 'project') === null) { mkdirSync(join(canonicalProjectRoot, '.saivage', 'cards'), { recursive: true }); const root = newProjectRootInput(canonicalProjectRoot); publishInitialProjectCard(canonicalProjectRoot, root.card, root.brief, 'analyst'); }
    console.log(`Project initialized at ${canonicalProjectRoot}`);
  });
}
async function handleStart(_options: CliOptions, args: string[]): Promise<void> { const app = await startApp({ argv: args }); console.log(`Saivage server listening on http://${app.environment.server.host}:${app.environment.server.port}`); }
async function handleRuntimeControl(command: 'status' | 'pause' | 'resume' | 'stop' | 'restart_server'): Promise<void> {
  const projectRoot = findProjectRoot();
  if (projectRoot === null) throw new Error('Not in a Saivage project');
  const lock = readRuntimeLockStatus(projectRoot);
  if (lock.kind === 'indeterminate' || lock.kind === 'malformed') throw new Error(`Lifecycle lock ${lock.kind}: ${lock.detail}. ${lock.repairInstruction}`);
  if (lock.kind === 'missing' || lock.kind === 'dead') {
    if (command === 'status') {
      console.log('Service: stopped (no live owner)');
      console.log('Runtime status: stopped');
      console.log('Current card: (none)');
    } else if (command === 'stop') {
      console.log(JSON.stringify({ status: 'stopped', contained: false }));
    } else {
      throw new Error(`No live Saivage runtime owns this project; cannot ${command}.`);
    }
    if (lock.kind === 'dead') console.log(lock.repairInstruction);
    return;
  }
  const endpoint = lock.record.control_endpoint;
  if (endpoint === null) throw new Error('active lifecycle owner; runtime control unavailable');
  const client = new OperatorRuntimeHttpClient();
  if (command === 'status') { console.log(JSON.stringify(await client.getRuntimeStatus(endpoint))); return; }
  if (command === 'pause') { console.log(JSON.stringify(await client.pauseRuntime(endpoint))); return; }
  if (command === 'resume') { console.log(JSON.stringify(await client.resumeRuntime(endpoint))); return; }
  if (command === 'stop') { console.log(JSON.stringify(await client.stopProject(endpoint))); return; }
  if (endpoint.auth === 'disabled') throw new Error('restart unavailable: operator authentication disabled');
  if (!process.env.SAIVAGE_API_TOKEN) throw new Error('Live service requires bearer authentication; set SAIVAGE_API_TOKEN.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmation = await prompt.question('Type RESTART SERVER to confirm: ');
    if (confirmation !== 'RESTART SERVER') throw new Error('Server restart confirmation was not provided.');
  } finally { prompt.close(); }
  console.log(JSON.stringify(await client.restartServer(endpoint)));
}
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
    mkdirSync(join(canonicalProjectRoot, '.saivage', 'cards'), { recursive: true });
    const root = newProjectRootInput(canonicalProjectRoot);
    publishInitialProjectCard(canonicalProjectRoot, root.card, root.brief, 'analyst');
    console.log('Project reset and reinitialized with an empty current layout and root project card. Durable credentials, config, prompt overrides, skills, instructions, and source/docs were preserved.');
  });
}
function handleHelp(): void { console.log(USAGE); }
export async function run(args: string[]): Promise<void> { const { command, options } = parseCommand(args); switch (command) { case 'init': await handleInit(options); break; case 'start': await handleStart(options, args); break; case 'status': case 'resume': case 'pause': case 'stop': case 'restart_server': if (Object.keys(options).length > 0) throw new Error(`${command} accepts no options.`); await handleRuntimeControl(command); break; case 'reset': await handleReset(); break; case 'help': case '--help': case '-h': handleHelp(); break; default: throw new Error(`Unknown command: ${command}`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { run(process.argv).catch((err: unknown) => { console.error(`Fatal error: ${(err as Error).message}`); process.exit(1); }); }
