#!/usr/bin/env node

/**
 * Saivage v3 CLI Entry Point
 *
 * Commands:
 *   saivage init [--force]             Initialize a project file tree
 *   saivage start [--create-runtime] [--port <port>] [--host <host>]
 *                                      Start the Saivage server
 *   saivage status                     Show runtime state
 *   saivage freeze [reason] [--kill-processes]            Freeze the runtime with an optional reason
 *   saivage resume                     Resume the runtime from a freeze manifest
 *   saivage help                       Print usage information
 */

import { parseArgs } from 'node:util';

// ── Types ──────────────────────────────────────────────────────

interface CliOptions {
  "kill-processes"?: boolean;
  force?: boolean;
  'create-runtime'?: boolean;
  port?: string;
  host?: string;
}

// ── Help Text ─────────────────────────────────────────────────

const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--force]
      Initialize a Saivage project file tree in the current directory.
      If already initialized, the command is a no-op unless --force is passed.

  saivage start [--create-runtime] [--port <port>] [--host <host>]
      Start the Saivage server.
        --create-runtime   Also start the ActiveRuntime for goal execution.
        --port <port>      Override the server port (env: SAIVAGE_PORT).
        --host <host>      Override the server host (env: SAIVAGE_HOST).

  saivage status
      Show runtime state from .saivage/runtime/state.json.
      Prints a warning if not in a Saivage project directory.

  saivage freeze [reason]
      Freeze the runtime. Persists a freeze manifest and stops dispatch.
      Optional reason string describes why the freeze was requested.
        --kill-processes  Default process action to "kill" instead of "reattach".

  saivage resume
      Resume the runtime from a saved freeze manifest.
      Restores queue, active card, and process tracking from the manifest.

  saivage help
      Print this usage information.

Environment Variables:
  SAIVAGE_PORT           Server port (overrides saivage.json config).
  SAIVAGE_HOST           Server host (overrides saivage.json config).
  LOG_LEVEL              Server log level (debug | info | warn | error).
  NODE_ENV               Set to 'development' for pretty-printed logs.
`;

// ── Argument Parsing ──────────────────────────────────────────

function parseCommand(rawArgs: string[]): {
  command: string;
  options: CliOptions;
} {
  // rawArgs[0] is node, rawArgs[1] is the script path
  const args = rawArgs.slice(2);

  if (args.length === 0) {
    return { command: 'help', options: {} };
  }

  const command = args[0]!;
  const rest = args.slice(1);

  let options: CliOptions = {};

  if (rest.length > 0) {
    try {
      const parsed = parseArgs({
        args: rest,
        options: {
          force:      { type: 'boolean' as const },
          'create-runtime': { type: 'boolean' as const },
          port:       { type: 'string' as const },
          host:       { type: "string" as const },
          "kill-processes": { type: "boolean" as const },
        },
        allowPositionals: false,
        strict: true,
      });
      options = parsed.values as CliOptions;
    } catch (err) {
      // parseArgs throws on unknown flags; show help and bail
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  return { command, options };
}

// ── Command Handlers ──────────────────────────────────────────

async function handleInit(options: CliOptions): Promise<void> {
  const { initProjectTree, isInitialized } = await import('./utils/file-tree.js');

  const projectRoot = process.cwd();

  if (!options.force && isInitialized(projectRoot)) {
    console.log(`Project already initialized at ${projectRoot}`);
    return;
  }

  initProjectTree(projectRoot);
  console.log(`Project initialized at ${projectRoot}`);
}

async function handleStart(options: CliOptions): Promise<void> {
  const { startServer } = await import('./server/server.js');

  const projectRoot = process.cwd();
  const createRuntime = options['create-runtime'] === true;

  const host = options.host ?? process.env['SAIVAGE_HOST'] ?? '0.0.0.0';
  const portStr = options.port ?? process.env['SAIVAGE_PORT'] ?? '8080';
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${portStr}`);
    process.exit(1);
  }

  // Override host/port via the underlying server config mechanism.
  // We set env vars before creating the server so the server can read them
  // if its config loading doesn't provide them.
  const origHost = process.env['SAIVAGE_HOST'];
  const origPort = process.env['SAIVAGE_PORT'];
  process.env['SAIVAGE_HOST'] = host;
  process.env['SAIVAGE_PORT'] = String(port);

  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  // Graceful shutdown on signals
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    if (server) {
      try {
        await server.stop();
      } catch (err) {
        console.error(`Error during shutdown: ${(err as Error).message}`);
      }
    }
    // Restore original env vars
    if (origHost === undefined) delete process.env['SAIVAGE_HOST'];
    else process.env['SAIVAGE_HOST'] = origHost;
    if (origPort === undefined) delete process.env['SAIVAGE_PORT'];
    else process.env['SAIVAGE_PORT'] = origPort;
    process.exit(0);
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  try {
    server = await startServer(projectRoot, createRuntime);
    console.log(`Saivage server listening on http://${host}:${port}`);
  } catch (err) {
    console.error(`Failed to start server: ${(err as Error).message}`);
    // Restore original env vars on error too
    if (origHost === undefined) delete process.env['SAIVAGE_HOST'];
    else process.env['SAIVAGE_HOST'] = origHost;
    if (origPort === undefined) delete process.env['SAIVAGE_PORT'];
    else process.env['SAIVAGE_PORT'] = origPort;
    process.exit(1);
  }
}

async function handleStatus(): Promise<void> {
  const { findProjectRoot } = await import('./utils/discovery.js');
  const { readRuntimeState } = await import('./utils/runtime-state.js');

  const projectRoot = findProjectRoot();
  if (projectRoot === null) {
    console.log('Not in a Saivage project');
    return;
  }

  const state = readRuntimeState(projectRoot);
  if (state === null) {
    console.log(`Project root: ${projectRoot}`);
    console.log('Runtime state: not initialized (no state.json)');
    return;
  }

  console.log(`Project root: ${projectRoot}`);
  console.log(`Status:       ${state.status}`);
  console.log(`PID:          ${state.pid}`);
  console.log(`Paused:       ${state.paused}`);
  console.log(`Current card: ${state.current_card_id ?? '(none)'}`);
  console.log(`Started at:   ${state.started_at}`);
  console.log(`Queue length: ${state.queue.length}`);
}

async function handleFreeze(freezeArgs: string[]): Promise<void> {
  const { findProjectRoot } = await import('./utils/discovery.js');
  const { readRuntimeState, updateRuntimeState } = await import('./utils/runtime-state.js');
  const { saveFreezeManifest, readFreezeManifest } = await import('./utils/freeze-manifest.js');

  const projectRoot = findProjectRoot();
  if (projectRoot === null) {
    console.error('Not in a Saivage project');
    process.exit(1);
  }

  // Check if already frozen
  const existingManifest = readFreezeManifest(projectRoot);
  if (existingManifest) {
    console.log('Runtime is already frozen.');
    console.log(`Freeze ID: ${existingManifest.freeze_id}`);
    console.log(`Reason:    ${existingManifest.reason}`);
    console.log(`Created:   ${existingManifest.created_at}`);
    return;
  }

  const reason = freezeArgs.length > 0 ? freezeArgs.join(" ") : undefined;
  const killProcesses = freezeArgs.includes("--kill-processes");
  const state = readRuntimeState(projectRoot);
  if (!state) {
    console.error('Cannot freeze: runtime state not initialized.');
    console.error('Run "saivage init" first.');
    process.exit(1);
  }

  const now = new Date();
  const freezeId = `freeze-${now.toISOString().replace(/[:.]/g, '-')}`;

  const manifest = {
    freeze_id: freezeId,
    reason: reason ?? 'operator requested freeze',
    created_at: now.toISOString(),
    status: 'frozen' as const,
    project_id: 'project' as const,
    pid: process.pid,
    started_at: state.started_at,
    current_card_id: state.current_card_id ?? null,
    current_agent_session_id: state.current_agent_session_id ?? null,
    queue: state.queue,
    running_processes: state.running_processes.map((id) => ({ id, action: (killProcesses ? "kill" : "reattach") as "kill" | "reattach" | "detach" })),
    handoff_summaries: [],
    schema_version: 1,
    runtime_version: '0.1.0',
  };

  saveFreezeManifest(projectRoot, manifest);

  // Update runtime state to frozen
  updateRuntimeState(projectRoot, {
    status: 'frozen',
    paused: true,
    paused_at: now.toISOString(),
  });

  console.log('Runtime frozen.');
  console.log(`Freeze ID: ${manifest.freeze_id}`);
  console.log(`Reason:    ${manifest.reason}`);
  console.log(`Created:   ${manifest.created_at}`);
}

async function handleResume(): Promise<void> {
  const { findProjectRoot } = await import('./utils/discovery.js');
  const { readFreezeManifest, clearFreezeManifest } = await import('./utils/freeze-manifest.js');
  const { updateRuntimeState } = await import('./utils/runtime-state.js');

  const projectRoot = findProjectRoot();
  if (projectRoot === null) {
    console.error('Not in a Saivage project');
    process.exit(1);
  }

  const manifest = readFreezeManifest(projectRoot);
  if (!manifest) {
    console.error('Cannot resume: no freeze manifest found. The runtime is not frozen.');
    process.exit(1);
  }

  // Restore state from manifest
  updateRuntimeState(projectRoot, {
    status: 'idle',
    current_card_id: manifest.current_card_id,
    current_agent_session_id: manifest.current_agent_session_id,
    paused: false,
    paused_at: null,
    queue: manifest.queue,
    running_processes: manifest.running_processes.map((p) => p.id),
  });

  clearFreezeManifest(projectRoot);

  console.log(`Runtime resumed from freeze ${manifest.freeze_id}.`);
  console.log(`Queue:     ${manifest.queue.length} cards`);
  console.log(`Processes: ${manifest.running_processes.length} running`);
  if (manifest.current_card_id) {
    console.log(`Active card: ${manifest.current_card_id}`);
  }
}

function handleHelp(): void {
  console.log(USAGE);
}

// ── Main Entry Point ──────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const { command, options } = parseCommand(args);
  const rest = args.slice(3); // remaining positional args after 'node cli.js <command>'

  switch (command) {
    case 'init':
      await handleInit(options);
      break;
    case 'start':
      await handleStart(options);
      break;
    case 'status':
      await handleStatus();
      break;
    case 'freeze':
      await handleFreeze(rest);
      break;
    case 'resume':
      await handleResume();
      break;
    case 'help':
    case '--help':
    case '-h':
      handleHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "saivage help" for usage information.');
      process.exit(1);
  }
}

// ── CLI Bootstrap ─────────────────────────────────────────────

run(process.argv).catch((err: unknown) => {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
