#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import {
  publishInitialProjectRuntime,
  startApp,
  withDirectMutationComposition,
  type StartInputs,
} from './boot/index.js';
import {
  findProjectRoot,
  resetOwnedGeneratedRoots,
  readProjectIdentity,
  readProjectCardOrAssertInitialPublicationAllowed,
  initializeAndValidateCurrentGeneratedState,
} from './persistence/index.js';
import { readRuntimeLockStatus } from './runtime/runtime-api.js';
import { OperatorRuntimeHttpClient } from './application/index.js';
import {
  DEFAULT_SYSTEM_TEMPLATE,
  resolveSystemTemplate,
  replaceConfigYaml,
  createResolvedConfigAuthority,
  formatConfigWarning,
} from './config/index.js';
import { SAIVAGE_VERSION } from './version.js';
import { createApplicationFatalPort, PublicationOutcomeUnknownError } from './contracts/index.js';
import { handleRepair, type RepairInputs } from './cli-repair.js';
import { parseRepairTarget } from './persistence/index.js';
import { cardTypeNameSchema } from './schemas/index.js';

const fatalPort = createApplicationFatalPort();

function loadCanonicalWorkflows(projectRoot: string) {
  const path = join(projectRoot, '.saivage', 'saivage.yaml');
  const authority = createResolvedConfigAuthority({
    path,
    interpolationEnvironment: process.env,
    projectRoot,
  });
  const effective = authority.loadEffective();
  for (const warning of effective.warnings) console.error(formatConfigWarning(warning));
  return effective.workflows;
}

interface InitInputs {
  readonly profile?: string;
}
type Command =
  | 'init'
  | 'start'
  | 'status'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'restart_server'
  | 'reset'
  | 'repair'
  | 'help';
type ParsedCommand =
  | { readonly command: 'init'; readonly inputs: InitInputs }
  | { readonly command: 'start'; readonly inputs: StartInputs }
  | { readonly command: 'repair'; readonly inputs: RepairInputs }
  | { readonly command: Exclude<Command, 'init' | 'start' | 'repair'> };
const USAGE = `Saivage v3 CLI

Usage:
  saivage init [--profile <classic|classic-typed>]
  saivage start [--host <host>] [--port <port>] [--config <path>] [--project-root <path>] [--create-runtime]
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
  saivage repair --target <card:ID|record:ID/NAME|conversation:SESSION_ID> --backup <absolute-path> --report <absolute-path> [--discard-card --card-type <configured-type>]
      Interactive offline exact-target repair. Requires stopped service, verified
      absence of an owner, a fresh complete preserved backup outside generated state and typed
      acknowledgement before inspection. Prints/reports exact losses and effects
      before separate consent. No unattended mode, scans, reconstruction or restart.
      Every pre-existing lifecycle lock blocks repair. Backup existence does not
      verify completeness. Report must be fresh and outside generated/lifecycle
      roots and declared backup. Ordinary project source-side paths are allowed.
      Previous selections are fresh-published, never renamed over current. Pure
      inspection does not truncate; only reported postconsent current tails do.
      --discard-card requires both unusable own card selections and a second
      destructive confirmation. Non-root discard requires supplied --card-type.
      Type must be compiled/parent-permitted (depth 12 leaf); project type is fixed.
      Moves only six own roots, never children. Record-only damage cannot qualify.
      Partial effects/dependencies may still block restart. Attic is retained by reset.
      FAILED is not an operator-only hold: later ancestor Run can Planner-reopen
      the synthetic card and execute its placeholder requirements.
  saivage help
`;
function parseSingletonOptions(
  args: readonly string[],
  options: Record<string, { readonly type: 'string' | 'boolean' }>,
): Record<string, string | boolean | undefined> {
  const parsed = parseArgs({
    args: [...args],
    options,
    allowPositionals: false,
    strict: true,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Option --${token.name} may only be specified once.`);
    seen.add(token.name);
  }
  return parsed.values;
}

function parseCommand(rawArgs: string[]): ParsedCommand {
  const args = rawArgs.slice(2);
  const rawCommand = args[0] ?? 'help';
  const command = rawCommand === '--help' || rawCommand === '-h' ? 'help' : rawCommand;
  const rest = args.slice(1);
  if (command === 'repair') {
    const values = parseSingletonOptions(rest, {
      target: { type: 'string' },
      backup: { type: 'string' },
      report: { type: 'string' },
      'discard-card': { type: 'boolean' },
      'card-type': { type: 'string' },
    });
    if (
      typeof values.target !== 'string' ||
      typeof values.backup !== 'string' ||
      typeof values.report !== 'string'
    )
      throw new Error('Repair requires --target, --backup and --report.');
    const target = parseRepairTarget(values.target);
    if (
      (values['discard-card'] === true || values['card-type'] !== undefined) &&
      target.kind !== 'card'
    )
      throw new Error('Discard/type options require a card target.');
    if (values['card-type'] !== undefined && values['discard-card'] !== true)
      throw new Error('--card-type requires --discard-card.');
    if (values['card-type'] !== undefined) cardTypeNameSchema.parse(values['card-type']);
    return {
      command,
      inputs: {
        target: values.target,
        backup: values.backup,
        report: values.report,
        discardCard: values['discard-card'] === true,
        cardType: values['card-type'] as string | undefined,
      },
    };
  }
  if (command === 'init') {
    const values = parseSingletonOptions(rest, { profile: { type: 'string' } });
    return { command, inputs: { profile: values['profile'] as string | undefined } };
  }
  if (command === 'start') {
    const values = parseSingletonOptions(rest, {
      host: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
      'project-root': { type: 'string' },
      'create-runtime': { type: 'boolean' },
    });
    return {
      command,
      inputs: {
        host: values['host'] as string | undefined,
        port: values['port'] as string | undefined,
        config: values['config'] as string | undefined,
        projectRoot: values['project-root'] as string | undefined,
        createRuntime: values['create-runtime'] === true,
      },
    };
  }
  const commandsWithoutOptions = new Set([
    'status',
    'pause',
    'resume',
    'stop',
    'restart_server',
    'reset',
    'help',
  ]);
  if (!commandsWithoutOptions.has(command)) throw new Error(`Unknown command: ${command}`);
  parseSingletonOptions(rest, {});
  return { command: command as Exclude<Command, 'init' | 'start' | 'repair'> };
}
function materializePromptTree(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isDirectory())
      materializePromptTree(join(sourceRoot, entry.name), join(destinationRoot, entry.name));
    else if (entry.isFile()) {
      const destination = join(destinationRoot, entry.name);
      if (existsSync(destination)) continue;
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(sourceRoot, entry.name), destination);
    }
  }
}
async function handleInit(options: InitInputs): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'init', fatalPort, (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const template = resolveSystemTemplate(options.profile ?? DEFAULT_SYSTEM_TEMPLATE);
    const configPath = join(canonicalProjectRoot, '.saivage', 'saivage.yaml');
    let configurationMaterialized = false;
    if (!existsSync(configPath)) {
      materializePromptTree(
        template.promptRoot,
        join(canonicalProjectRoot, '.saivage', 'config', 'prompts'),
      );
      writeFileSync(
        join(canonicalProjectRoot, '.saivage', 'config', 'template.json'),
        JSON.stringify({ template: template.name, saivage_version: SAIVAGE_VERSION }),
      );
      replaceConfigYaml(configPath, structuredClone(template.config));
      configurationMaterialized = true;
    }
    const workflows = loadCanonicalWorkflows(canonicalProjectRoot);
    if (readProjectIdentity(canonicalProjectRoot) === null)
      composition.createAndBindProjectIdentity();
    const projectCard = readProjectCardOrAssertInitialPublicationAllowed(canonicalProjectRoot);
    if (projectCard === null) {
      publishInitialProjectRuntime(canonicalProjectRoot, workflows);
    }
    initializeAndValidateCurrentGeneratedState(canonicalProjectRoot, workflows);
    console.log(
      projectCard === null
        ? `Project layout initialized at ${canonicalProjectRoot}`
        : `Project layout already exists at ${canonicalProjectRoot}`,
    );
    console.log(
      configurationMaterialized
        ? `Configuration materialized from template ${template.name}`
        : 'Existing configuration preserved',
    );
  });
}
async function handleStart(inputs: StartInputs): Promise<void> {
  const app = await startApp(inputs);
  console.log(
    `Saivage server listening on http://${app.environment.server.host}:${app.environment.server.port}`,
  );
}
async function handleRuntimeControl(
  command: 'status' | 'pause' | 'resume' | 'stop' | 'restart_server',
): Promise<void> {
  const projectRoot = findProjectRoot();
  if (projectRoot === null) throw new Error('Not in a Saivage project');
  const lock = readRuntimeLockStatus(projectRoot);
  if (lock.kind === 'indeterminate' || lock.kind === 'malformed')
    throw new Error(`Lifecycle lock ${lock.kind}: ${lock.detail}. ${lock.repairInstruction}`);
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
  if (command === 'status') {
    console.log(JSON.stringify(await client.getRuntimeStatus(endpoint)));
    return;
  }
  if (command === 'pause') {
    console.log(JSON.stringify(await client.pauseRuntime(endpoint)));
    return;
  }
  if (command === 'resume') {
    console.log(JSON.stringify(await client.resumeRuntime(endpoint)));
    return;
  }
  if (command === 'stop') {
    console.log(JSON.stringify(await client.stopProject(endpoint)));
    return;
  }
  if (endpoint.auth === 'disabled')
    throw new Error('restart unavailable: operator authentication disabled');
  const token = process.env.SAIVAGE_API_TOKEN;
  if (!token || token.trim() === '')
    throw new Error(
      'Live service requires bearer authentication; set a non-blank SAIVAGE_API_TOKEN.',
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmation = await prompt.question('Type RESTART SERVER to confirm: ');
    if (confirmation !== 'RESTART SERVER')
      throw new Error('Server restart confirmation was not provided.');
  } finally {
    prompt.close();
  }
  console.log(JSON.stringify(await client.restartServer(endpoint)));
}
async function handleReset(): Promise<void> {
  const projectRoot = process.cwd();
  withDirectMutationComposition(projectRoot, 'bound', fatalPort, (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const workflows = loadCanonicalWorkflows(canonicalProjectRoot);
    const generatedRoots = resetOwnedGeneratedRoots(canonicalProjectRoot);
    console.log('Reset will remove these exact generated roots as whole trees:');
    for (const target of generatedRoots) console.log(`- ${target}`);
    console.log('The lifecycle-lock namespace and every path outside these roots are preserved.');
    for (const target of generatedRoots) rmSync(target, { recursive: true, force: true });
    publishInitialProjectRuntime(canonicalProjectRoot, workflows);
    console.log(
      'Project reset with a new root project card. Every path outside the four reset-owned generated roots was preserved.',
    );
  });
}
function handleHelp(): void {
  console.log(USAGE);
}
export async function run(args: string[]): Promise<void> {
  const parsed = parseCommand(args);
  switch (parsed.command) {
    case 'init':
      await handleInit(parsed.inputs);
      break;
    case 'start':
      await handleStart(parsed.inputs);
      break;
    case 'status':
    case 'resume':
    case 'pause':
    case 'stop':
    case 'restart_server':
      await handleRuntimeControl(parsed.command);
      break;
    case 'reset':
      await handleReset();
      break;
    case 'repair':
      await handleRepair(parsed.inputs, fatalPort);
      break;
    case 'help':
      handleHelp();
      break;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv).catch((err: unknown) => {
    if (err instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(err);
    console.error(`Fatal error: ${(err as Error).message}`);
    process.exit(1);
  });
}
