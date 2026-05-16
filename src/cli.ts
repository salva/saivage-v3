#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isLocked } from './utils/runtime-lock.js';

interface CliOptions { 'kill-processes'?: boolean; force?: boolean; 'create-runtime'?: boolean; port?: string; host?: string; }

const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--force]
  saivage start [--create-runtime] [--port <port>] [--host <host>]
  saivage status
  saivage freeze [reason] [--kill-processes]
  saivage resume
  saivage reset
      Remove .saivage/cards, .saivage/runtime, and .saivage/notes.
      Preserves credentials and project files such as .saivage/auth-profiles.json,
      .saivage/project.json, .saivage/saivage.json, and research/future-objectives.
      Refuses while the runtime lockfile is present.
  saivage help
`;

function parseCommand(rawArgs: string[]): { command: string; options: CliOptions } {
  const args = rawArgs.slice(2); if (args.length === 0) return { command: 'help', options: {} }; const command = args[0]!; const rest = args.slice(1); let options: CliOptions = {};
  if (rest.length > 0) { const parsed = parseArgs({ args: rest, options: { force: { type: 'boolean' }, 'create-runtime': { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' }, 'kill-processes': { type: 'boolean' } }, allowPositionals: false, strict: true }); options = parsed.values as CliOptions; }
  return { command, options };
}

async function handleInit(options: CliOptions): Promise<void> { const { initProjectTree, isInitialized } = await import('./utils/file-tree.js'); const projectRoot = process.cwd(); if (!options.force && isInitialized(projectRoot)) { console.log(`Project already initialized at ${projectRoot}`); return; } initProjectTree(projectRoot); console.log(`Project initialized at ${projectRoot}`); }
async function handleStart(options: CliOptions): Promise<void> { const { startServer } = await import('./server/server.js'); const projectRoot = process.cwd(); const createRuntime = options['create-runtime'] === true; const host = options.host ?? process.env['SAIVAGE_HOST'] ?? '0.0.0.0'; const port = parseInt(options.port ?? process.env['SAIVAGE_PORT'] ?? '8080', 10); const server = await startServer(projectRoot, createRuntime); console.log(`Saivage server listening on http://${host}:${port}`); process.once('SIGINT', () => { void server.stop().then(() => process.exit(0)); }); process.once('SIGTERM', () => { void server.stop().then(() => process.exit(0)); }); }
async function handleStatus(): Promise<void> { const { findProjectRoot } = await import('./utils/discovery.js'); const { readRuntimeState } = await import('./utils/runtime-state.js'); const projectRoot = findProjectRoot(); if (projectRoot === null) { console.log('Not in a Saivage project'); return; } const state = readRuntimeState(projectRoot); if (state === null) { console.log(`Project root: ${projectRoot}`); console.log('Runtime state: not initialized (no state.json)'); return; } console.log(`Project root: ${projectRoot}`); console.log(`Status:       ${state.status}`); console.log(`PID:          ${state.pid}`); console.log(`Paused:       ${state.paused}`); console.log(`Current card: ${state.current_card_id ?? '(none)'}`); console.log(`Started at:   ${state.started_at}`); console.log(`Queue length: ${state.queue.length}`); }
async function handleFreeze(): Promise<void> {}
async function handleResume(): Promise<void> {}
async function handleReset(): Promise<void> { const projectRoot = process.cwd(); if (isLocked(projectRoot)) throw new Error('Cannot reset while the server/runtime lockfile is present. Stop the server and try again.'); const targets = ['cards', 'runtime', 'notes'].map((name) => join(projectRoot, '.saivage', name)); console.log('Reset will remove:'); for (const target of targets) console.log(`- ${target}`); for (const target of targets) if (existsSync(target)) rmSync(target, { recursive: true, force: true }); }
function handleHelp(): void { console.log(USAGE); }

export async function run(args: string[]): Promise<void> { const { command, options } = parseCommand(args); switch (command) { case 'init': await handleInit(options); break; case 'start': await handleStart(options); break; case 'status': await handleStatus(); break; case 'freeze': await handleFreeze(); break; case 'resume': await handleResume(); break; case 'reset': await handleReset(); break; case 'help': case '--help': case '-h': handleHelp(); break; default: throw new Error(`Unknown command: ${command}`); } }

if (process.argv[1] && process.argv[1].includes('cli')) { run(process.argv).catch((err: unknown) => { console.error(`Fatal error: ${(err as Error).message}`); process.exit(1); }); }
