#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { startApp } from './boot/index.js';
import { newProjectRootInput } from './boot/app.js';
import { findProjectRoot } from './persistence/index.js';
import { readRuntimeLockStatus } from './runtime/lock.js';
import { resetOwnedGeneratedRoots, saivageCardsRoot } from './persistence/layout.js';
import { withDirectMutationComposition } from './boot/direct-mutation-composition.js';
import { publishInitialProjectCard } from './persistence/card-files.js';
import { readProjectIdentity } from './persistence/project-identity.js';
import { readProjectCardOrAssertInitialPublicationAllowed } from './persistence/generated-state.js';
import { OperatorRuntimeHttpClient } from './application/operator-runtime-http-client.js';
import { DEFAULT_SAIVAGE_CONFIG } from './agents/default-workflow-config.js';
import { replaceConfigYaml } from './config/config-file.js';
import { createResolvedConfigAuthority } from './config/resolved-config-authority.js';

function loadCanonicalWorkflows(projectRoot:string){const path=join(projectRoot,'.saivage','saivage.yaml');const authority=createResolvedConfigAuthority({path,source:{kind:'default'},interpolationEnvironment:process.env,projectRoot});return authority.loadEffective().workflows;}

interface CliOptions { port?: string; host?: string; config?: string; 'project-root'?: string; 'create-runtime'?: boolean; }
const USAGE = `Saivage v3 CLI

Usage:
  saivage init
  saivage start [--port <port>] [--host <host>] [--project-root <path>] [--create-runtime]
  saivage status
  saivage pause
  saivage resume
  saivage stop
  saivage restart_server
  saivage reset
      Acquires .saivage/locks/runtime.lock before deletion and fails closed if
      that exact lock already exists. It removes exactly .saivage/cards,
      .saivage/agents, .saivage/logs, and .saivage/work as whole trees, then
      publishes a new root project card while retaining the lock. The lock
      namespace is a safety boundary, not reset-owned state; sibling entries
      are untouched. Every path outside the four exact roots is preserved.
      After verifying no Saivage process owns the project, remove an abandoned
      canonical runtime.lock manually and retry.
  saivage help
`;
function parseCommand(rawArgs: string[]): { command: string; options: CliOptions } { const args = rawArgs.slice(2); if (args.length === 0) return { command: 'help', options: {} }; const command = args[0]!; const rest = args.slice(1); let options: CliOptions = {}; if (rest.length > 0) { const parsed = parseArgs({ args: rest, options: { port: { type: 'string' }, host: { type: 'string' }, config: { type: 'string' }, 'project-root': { type: 'string' }, 'create-runtime': { type: 'boolean' } }, allowPositionals: false, strict: true }); options = parsed.values as CliOptions; } return { command, options }; }
async function handleInit(): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'init', (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const configPath=join(canonicalProjectRoot,'.saivage','saivage.yaml');
    if(!existsSync(configPath))replaceConfigYaml(configPath,DEFAULT_SAIVAGE_CONFIG);
    const workflows=loadCanonicalWorkflows(canonicalProjectRoot);
    if (readProjectIdentity(canonicalProjectRoot) === null) composition.createAndBindProjectIdentity();
    if (readProjectCardOrAssertInitialPublicationAllowed(canonicalProjectRoot) !== null) { console.log(`Project already initialized at ${canonicalProjectRoot}`); return; }
    mkdirSync(join(canonicalProjectRoot, '.saivage', 'cards'), { recursive: true });
    const root = newProjectRootInput(canonicalProjectRoot);
    publishInitialProjectCard(canonicalProjectRoot, root,workflows.cardTypes.get('project')!);
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
async function handleReset(): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'bound', (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const workflows=loadCanonicalWorkflows(canonicalProjectRoot);
    const generatedRoots = resetOwnedGeneratedRoots(canonicalProjectRoot);
    console.log('Reset will remove these exact generated roots as whole trees:');
    for (const target of generatedRoots) console.log(`- ${target}`);
    console.log('The lifecycle-lock namespace and every path outside these roots are preserved.');
    for (const target of generatedRoots) rmSync(target, { recursive: true, force: true });
    mkdirSync(saivageCardsRoot(canonicalProjectRoot), { recursive: true });
    const root = newProjectRootInput(canonicalProjectRoot);
    publishInitialProjectCard(canonicalProjectRoot, root,workflows.cardTypes.get('project')!);
    console.log('Project reset with a new root project card. Every path outside the four reset-owned generated roots was preserved.');
  });
}
function handleHelp(): void { console.log(USAGE); }
export async function run(args: string[]): Promise<void> { const { command, options } = parseCommand(args); switch (command) { case 'init': await handleInit(); break; case 'start': await handleStart(options, args); break; case 'status': case 'resume': case 'pause': case 'stop': case 'restart_server': if (Object.keys(options).length > 0) throw new Error(`${command} accepts no options.`); await handleRuntimeControl(command); break; case 'reset': await handleReset(); break; case 'help': case '--help': case '-h': handleHelp(); break; default: throw new Error(`Unknown command: ${command}`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { run(process.argv).catch((err: unknown) => { console.error(`Fatal error: ${(err as Error).message}`); process.exit(1); }); }
