#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import * as YAML from 'yaml';
import { gitProvisioningSchema } from './schemas/index.js';
import { materializeSystemTemplate } from './config/index.js';
import { createInterface } from 'node:readline/promises';
import {
  publishInitialProjectRuntime,
  assertInitialProjectPolicy,
  preflightInitialProjectSource,
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
import { WorkGcRequestSchema, type WorkGcRequest } from './contracts/index.js';
import { handleRepair, type RepairInputs } from './cli-repair.js';
import { parseRepairTarget } from './persistence/index.js';
import { cardTypeNameSchema } from './schemas/index.js';
import {
  prepareObservedCollections,
  type PrepareObservedCollectionsInputs,
} from './retrieval/index.js';

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
  readonly gitProvisioning?: z.infer<typeof gitProvisioningSchema>;
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
  | 'gc-work'
  | 'observed-collections'
  | 'help';
type ParsedCommand =
  | { readonly command: 'init'; readonly inputs: InitInputs }
  | { readonly command: 'start'; readonly inputs: StartInputs }
  | { readonly command: 'repair'; readonly inputs: RepairInputs }
  | { readonly command: 'gc-work'; readonly inputs: WorkGcRequest }
  | { readonly command: 'observed-collections'; readonly inputs: PrepareObservedCollectionsInputs }
  | {
      readonly command: Exclude<
        Command,
        'init' | 'start' | 'repair' | 'observed-collections' | 'gc-work'
      >;
    };
const USAGE = `Saivage v3 CLI

Usage:
  saivage observed-collections prepare --project-root <absolute-path> --output <fresh-absolute-directory> --executable <absolute-path> --model-directory <absolute-path> --data-directory <existing-absolute-directory> --user <service-user> [--port 19880] [--rest-port 19881] [--grpc-port 19882]
      Prepare private native engine/watcher configuration and systemd units only.
      No source walk, token copy, index creation, network or service action.
  saivage init [--profile <classic|classic-typed|paad-typed|classic-git>]
      Native provisioning (classic-git only):
      --git-delivery-branch <name> --git-private-ref-namespace <refs/saivage/...>
      --git-source-roots <JSON-array> --git-excluded-paths <JSON-array>
      Supply all four or none; paths are literal, not globs. Exclusions must
      explicitly include .git and .saivage. Existing policy must match exactly.
      Explicit --profile must match existing template selection; omitted profile
      preserves existing configuration rather than selecting a new default.
  saivage start [--host <host>] [--port <port>] [--config <path>] [--project-root <path>] [--create-runtime] [--failed-provider-diagnostics <UUID>] [--analyst-mode internal|external|both] [--analyst-mcp-port <port>] [--analyst-mcp-principal <id>] [--analyst-mcp-tools <names>]
  saivage status
  saivage pause
  saivage resume
  saivage stop
  saivage restart_server
  saivage gc-work [--before <RFC3339-with-zone>] [--target-bytes <bytes>] [--dry-run | --delete]
      Preview first with --dry-run (also the default). Both modes pause the live
      owner for fresh marking; busy mutations reject, Stop remains available.
      --delete is a separate fresh invocation and irreversibly removes eligible
      work files. Consider a separately preserved backup before deletion.
      Reports accounted logical bytes only, never whole-work or physical savings.
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
  if (command === 'gc-work') {
    const values = parseSingletonOptions(rest, {
      before: { type: 'string' },
      'target-bytes': { type: 'string' },
      'dry-run': { type: 'boolean' },
      delete: { type: 'boolean' },
    });
    if (values['dry-run'] && values.delete)
      throw new Error('--dry-run and --delete are mutually exclusive.');
    const bytes = values['target-bytes'];
    if (bytes !== undefined && (typeof bytes !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(bytes)))
      throw new Error('--target-bytes must be a nonnegative safe integer.');
    return {
      command,
      inputs: WorkGcRequestSchema.parse({
        mode: values.delete ? 'delete' : 'dry_run',
        before: values.before,
        target_bytes: bytes === undefined ? undefined : Number(bytes),
      }),
    };
  }
  if (command === 'observed-collections') {
    if (rest[0] !== 'prepare') throw new Error('Expected observed-collections prepare.');
    const values = parseSingletonOptions(rest.slice(1), {
      'project-root': { type: 'string' },
      output: { type: 'string' },
      executable: { type: 'string' },
      'model-directory': { type: 'string' },
      'data-directory': { type: 'string' },
      user: { type: 'string' },
      port: { type: 'string' },
      'rest-port': { type: 'string' },
      'grpc-port': { type: 'string' },
    });
    const required = (name: string): string => {
      const value = values[name];
      if (typeof value !== 'string' || !value) throw new Error(`Preparation requires --${name}.`);
      return value;
    };
    const port = (name: string, fallback: number): number => {
      const value = values[name];
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[0-9]+$/u.test(value))
        throw new Error('Invalid native port.');
      return Number(value);
    };
    return {
      command,
      inputs: {
        projectRoot: required('project-root'),
        output: required('output'),
        executable: required('executable'),
        modelDirectory: required('model-directory'),
        dataDirectory: required('data-directory'),
        user: required('user'),
        port: port('port', 19880),
        restPort: port('rest-port', 19881),
        grpcPort: port('grpc-port', 19882),
      },
    };
  }
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
    const values = parseSingletonOptions(rest, {
      profile: { type: 'string' },
      'git-delivery-branch': { type: 'string' },
      'git-private-ref-namespace': { type: 'string' },
      'git-source-roots': { type: 'string' },
      'git-excluded-paths': { type: 'string' },
    });
    const names = [
      'git-delivery-branch',
      'git-private-ref-namespace',
      'git-source-roots',
      'git-excluded-paths',
    ];
    const supplied = names.filter((name) => values[name] !== undefined);
    if (supplied.length !== 0 && supplied.length !== names.length)
      throw new Error('Native provisioning requires all four --git-* options or none.');
    const profile = values.profile as string | undefined;
    if (supplied.length && profile !== undefined && profile !== 'classic-git')
      throw new Error('Native provisioning options cannot select an OFF profile.');
    const gitProvisioning = supplied.length
      ? gitProvisioningSchema.parse({
          delivery_branch: values['git-delivery-branch'],
          private_ref_namespace: values['git-private-ref-namespace'],
          source_roots: JSON.parse(values['git-source-roots'] as string),
          excluded_paths: JSON.parse(values['git-excluded-paths'] as string),
        })
      : undefined;
    return { command, inputs: { profile, gitProvisioning } };
  }
  if (command === 'start') {
    const values = parseSingletonOptions(rest, {
      host: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
      'project-root': { type: 'string' },
      'create-runtime': { type: 'boolean' },
      'failed-provider-diagnostics': { type: 'string' },
      'analyst-mode': { type: 'string' },
      'analyst-mcp-port': { type: 'string' },
      'analyst-mcp-principal': { type: 'string' },
      'analyst-mcp-tools': { type: 'string' },
    });
    if (values['failed-provider-diagnostics'] !== undefined)
      z.string().uuid().parse(values['failed-provider-diagnostics']);
    return {
      command,
      inputs: {
        host: values['host'] as string | undefined,
        port: values['port'] as string | undefined,
        config: values['config'] as string | undefined,
        projectRoot: values['project-root'] as string | undefined,
        createRuntime: values['create-runtime'] === true,
        failedProviderDiagnostics: values['failed-provider-diagnostics'] as string | undefined,
        analystMode: values['analyst-mode'] as string | undefined,
        analystMcpPort: values['analyst-mcp-port'] as string | undefined,
        analystMcpPrincipal: values['analyst-mcp-principal'] as string | undefined,
        analystMcpTools: values['analyst-mcp-tools'] as string | undefined,
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
  return {
    command: command as Exclude<
      Command,
      'init' | 'start' | 'repair' | 'observed-collections' | 'gc-work'
    >,
  };
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
  await withDirectMutationComposition(projectRoot, 'init', fatalPort, async (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const configPath = join(canonicalProjectRoot, '.saivage', 'saivage.yaml');
    let configurationMaterialized = false;
    let materializedProfile: string | null = null;
    let workflows: ReturnType<typeof loadCanonicalWorkflows>;
    if (!existsSync(configPath)) {
      const profile = options.profile ?? DEFAULT_SYSTEM_TEMPLATE;
      if (options.gitProvisioning && profile !== 'classic-git')
        throw new Error('Fresh native provisioning requires explicit --profile classic-git.');
      if (profile === 'classic-git' && !options.gitProvisioning)
        throw new Error(
          'Fresh classic-git configuration requires all four --git-* provisioning options.',
        );
      const template = resolveSystemTemplate(profile);
      const candidate = materializeSystemTemplate(template, options.gitProvisioning);
      // Resolve inputs and the actual selected prompt root before materializing
      // configuration or prompts. Canonical reload below remains authoritative.
      createResolvedConfigAuthority({
        path: configPath,
        projectRoot: canonicalProjectRoot,
        defaultPromptRoot: template.promptRoot,
        interpolationEnvironment: process.env,
      }).validateDocument(YAML.parseDocument(YAML.stringify(candidate)));
      materializePromptTree(
        template.promptRoot,
        join(canonicalProjectRoot, '.saivage', 'config', 'prompts'),
      );
      writeFileSync(
        join(canonicalProjectRoot, '.saivage', 'config', 'template.json'),
        JSON.stringify({ template: template.name, saivage_version: SAIVAGE_VERSION }),
      );
      replaceConfigYaml(configPath, candidate);
      configurationMaterialized = true;
      materializedProfile = template.name;
      workflows = loadCanonicalWorkflows(canonicalProjectRoot);
    } else {
      if (options.profile !== undefined) {
        resolveSystemTemplate(options.profile);
        const metadataPath = join(canonicalProjectRoot, '.saivage', 'config', 'template.json');
        if (!existsSync(metadataPath))
          throw new Error(
            'Explicit --profile cannot match an existing configuration without template selection metadata.',
          );
        const selected = z
          .object({ template: z.string().min(1), saivage_version: z.string().min(1) })
          .strict()
          .parse(JSON.parse(readFileSync(metadataPath, 'utf8')));
        if (selected.template !== options.profile)
          throw new Error('Explicit --profile conflicts with the existing template selection.');
      }
      const effective = createResolvedConfigAuthority({
        path: configPath,
        projectRoot: canonicalProjectRoot,
        interpolationEnvironment: process.env,
      }).loadEffective();
      for (const warning of effective.warnings) console.error(formatConfigWarning(warning));
      if (options.gitProvisioning) {
        const policy = effective.config.git_workflow;
        if (!policy?.enabled)
          throw new Error('Native provisioning cannot override an existing OFF configuration.');
        const selected = gitProvisioningSchema.parse({
          delivery_branch: policy.delivery_branch,
          private_ref_namespace: policy.private_ref_namespace,
          source_roots: policy.source_roots,
          excluded_paths: policy.excluded_paths,
        });
        if (JSON.stringify(selected) !== JSON.stringify(options.gitProvisioning))
          throw new Error('Native provisioning conflicts with the existing source policy.');
      }
      workflows = effective.workflows;
    }
    if (readProjectIdentity(canonicalProjectRoot) === null)
      composition.createAndBindProjectIdentity();
    const projectCard = readProjectCardOrAssertInitialPublicationAllowed(canonicalProjectRoot);
    if (projectCard === null) {
      await publishInitialProjectRuntime(canonicalProjectRoot, workflows, composition);
    }
    composition.assertCurrent();
    assertInitialProjectPolicy(canonicalProjectRoot, workflows);
    initializeAndValidateCurrentGeneratedState(canonicalProjectRoot, workflows);
    console.log(
      projectCard === null
        ? `Project layout initialized at ${canonicalProjectRoot}`
        : `Project layout already exists at ${canonicalProjectRoot}`,
    );
    console.log(
      configurationMaterialized
        ? `Configuration materialized from template ${materializedProfile}`
        : 'Existing configuration preserved',
    );
  });
}
async function handleStart(inputs: StartInputs): Promise<void> {
  const app = await startApp(inputs);
  const { host, port } = app.boundListener;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const qualification =
    host === '0.0.0.0' || host === '::'
      ? ' (wildcard bind; use a reachable host address to connect)'
      : '';
  console.log(`Saivage server listening on http://${urlHost}:${port}${qualification}`);
  if (app.server.analystMcpEndpoint !== null)
    console.log(`Analyst MCP: ${app.server.analystMcpEndpoint}`);
}
async function handleRuntimeControl(
  command: 'status' | 'pause' | 'resume' | 'stop' | 'restart_server' | WorkGcRequest,
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
      throw new Error(
        `No live Saivage runtime owns this project; cannot ${typeof command === 'string' ? command : 'gc-work'}.${lock.kind === 'dead' ? ` ${lock.repairInstruction}` : ''}`,
      );
    }
    if (lock.kind === 'dead') console.log(lock.repairInstruction);
    return;
  }
  const endpoint = lock.record.control_endpoint;
  if (endpoint === null) throw new Error('active lifecycle owner; runtime control unavailable');
  const client = new OperatorRuntimeHttpClient();
  if (typeof command !== 'string') {
    const result = await client.gcWork(endpoint, command);
    console.log(JSON.stringify(result));
    if (result.disposition !== 'completed') process.exitCode = 1;
    return;
  }
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
  await withDirectMutationComposition(projectRoot, 'bound', fatalPort, async (composition) => {
    const canonicalProjectRoot = composition.projectRoot;
    const workflows = loadCanonicalWorkflows(canonicalProjectRoot);
    const generatedRoots = resetOwnedGeneratedRoots(canonicalProjectRoot);
    composition.assertCurrent();
    preflightInitialProjectSource(canonicalProjectRoot, workflows);
    console.log('Reset will remove these exact generated roots as whole trees:');
    for (const target of generatedRoots) console.log(`- ${target}`);
    console.log('The lifecycle-lock namespace and every path outside these roots are preserved.');
    for (const target of generatedRoots) rmSync(target, { recursive: true, force: true });
    await publishInitialProjectRuntime(canonicalProjectRoot, workflows, composition);
    composition.assertCurrent();
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
    case 'gc-work':
      await handleRuntimeControl(parsed.inputs);
      break;
    case 'observed-collections':
      prepareObservedCollections(parsed.inputs);
      console.log('Observed collection bundle prepared; not installed or started.');
      break;
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
