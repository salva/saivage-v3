import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { publishFreshFile } from '../persistence/index.js';
import { isReadBlocked } from '../workspace/index.js';
import {
  OBSERVED_DEPLOYMENT,
  XERJ_KEY,
  XERJ_SOURCE,
  XERJ_BINARY_SHA256,
  XERJ_MODEL_REVISION,
  XERJ_MODEL_FILES,
  observedDeploymentSchema,
  readObservedCollections,
  type ObservedDeployment,
} from './collection-definitions.js';

export interface PrepareObservedCollectionsInputs {
  readonly projectRoot: string;
  readonly output: string;
  readonly executable: string;
  readonly modelDirectory: string;
  readonly dataDirectory: string;
  readonly user: string;
  readonly port: number;
  readonly restPort: number;
  readonly grpcPort: number;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(parent + sep);
const shellWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// systemd parses its own word/percent/dollar syntax; it is not shell quoting.
const unitWord = (value: string) =>
  `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;
const unitPath = (value: string) => value.replaceAll('%', '%%');
const toml = (value: string) => JSON.stringify(value);

export function prepareObservedCollections(input: PrepareObservedCollectionsInputs): {
  readonly output: string;
  readonly target: string;
  readonly roots: number;
} {
  for (const value of [
    input.projectRoot,
    input.output,
    input.executable,
    input.modelDirectory,
    input.dataDirectory,
  ]) {
    if (
      !isAbsolute(value) ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error('Preparation requires absolute paths without control characters.');
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(input.user))
    throw new Error('Preparation requires a Unix service user.');
  const ports = [input.port, input.restPort, input.grpcPort];
  if (
    ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535) ||
    new Set(ports).size !== 3
  ) {
    throw new Error('Preparation requires three distinct unprivileged ports.');
  }
  const project = realpathSync(input.projectRoot);
  const executable = realpathSync(input.executable);
  const model = realpathSync(input.modelDirectory);
  // Output and native storage parents must exist; exact metadata only, never a source walk.
  const output = join(
    realpathSync(dirname(input.output)),
    relative(dirname(input.output), input.output),
  );
  const dataBase = realpathSync(input.dataDirectory);
  if (contains(project, output) || contains(project, dataBase))
    throw new Error('Bundle and native storage must be outside the project.');
  if (hash(readFileSync(executable)) !== XERJ_BINARY_SHA256)
    throw new Error('Native executable does not match the selected build.');
  for (const [name, digest] of Object.entries(XERJ_MODEL_FILES)) {
    if (hash(readFileSync(join(model, name))) !== digest)
      throw new Error('Native model does not match the selected assets.');
  }
  const definitions = readObservedCollections(project);
  if (!definitions || definitions.collections.length === 0)
    throw new Error('Preparation requires observed collection definitions.');
  const directories = new Set<string>();
  for (const collection of definitions.collections) {
    const lexical = resolve(project, collection.directory);
    if (
      collection.directory.split('/').some((p) => p === '.saivage' || p === '.git') ||
      isReadBlocked(collection.directory)
    ) {
      throw new Error('Forbidden observed collection root.');
    }
    const actual = realpathSync(lexical);
    const rel = relative(project, actual).split(sep).join('/') || '.';
    if (
      !contains(project, actual) ||
      !statSync(actual).isDirectory() ||
      rel.split('/').some((p) => p === '.saivage' || p === '.git') ||
      isReadBlocked(rel) ||
      contains(actual, executable) ||
      contains(actual, model) ||
      contains(model, actual) ||
      contains(actual, dataBase) ||
      contains(dataBase, actual) ||
      contains(actual, output)
    ) {
      throw new Error('Forbidden observed collection root.');
    }
    directories.add(rel);
  }
  const roots = [...directories].sort();
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (
        contains(resolve(project, roots[i]!), resolve(project, roots[j]!)) ||
        contains(resolve(project, roots[j]!), resolve(project, roots[i]!))
      ) {
        throw new Error('Distinct ingestion roots must not overlap.');
      }
    }
  }
  const native = { source: XERJ_SOURCE, executable, sha256: XERJ_BINARY_SHA256 } as const;
  const modelIdentity = {
    revision: XERJ_MODEL_REVISION,
    directory: model,
    mode: 'neural',
    dimensions: 384,
    files: XERJ_MODEL_FILES,
  } as const;
  const identity = JSON.stringify({
    project,
    source: XERJ_SOURCE,
    binary: XERJ_BINARY_SHA256,
    model: XERJ_MODEL_REVISION,
    files: XERJ_MODEL_FILES,
    code_analyzer: 'code',
    no_default_ignores: true,
  });
  const instance = `saivage-xerj-${hash(identity).slice(0, 16)}`;
  const data = join(dataBase, instance);
  const descriptor: ObservedDeployment = observedDeploymentSchema.parse({
    format_version: 1,
    type: 'xerj-observed-deployment',
    endpoint: `http://127.0.0.1:${input.port}`,
    native,
    model: modelIdentity,
    roots: roots.map((directory) => ({
      directory,
      prefix: `sv-${hash(`${identity}\n${directory}`).slice(0, 32)}`,
    })),
  });
  const engineConfigPath = join(output, 'engine.toml');
  const environment = {
    HF_HUB_OFFLINE: '1',
    XERJ_DISABLE_FEEDBACK: 'true',
    RAYON_NUM_THREADS: '2',
  };
  const engineArgv = [executable, '--config', engineConfigPath];
  const watchers = descriptor.roots.map((root) => ({
    directory: root.directory,
    prefix: root.prefix,
    argv: [
      executable,
      'autoindex',
      resolve(project, root.directory),
      '--url',
      descriptor.endpoint,
      '--prefix',
      root.prefix,
      '--state-dir',
      join(data, 'watch', root.prefix),
      '--watch',
      '--no-graph',
      '--no-default-ignores',
      '--code-analyzer',
      'code',
      '--workers',
      '2',
      '--bulk-timeout-secs',
      '30',
      '--debounce',
      '1000',
    ],
  }));
  const engineUnit = `${instance}.service`;
  const target = `${instance}-watchers.target`;
  const watcherUnits = watchers.map((w) => `${instance}-${w.prefix}.service`);
  const common = `[Service]\nType=simple\nUser=${input.user}\nWorkingDirectory=${unitPath(project)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nEnvironment=HF_HUB_OFFLINE=1 XERJ_DISABLE_FEEDBACK=true RAYON_NUM_THREADS=2\n`;
  const engineConfig = `[server]\nbind_address="127.0.0.1"\nes_compat_port=${input.port}\nrest_port=${input.restPort}\ngrpc_port=${input.grpcPort}\nauto_port=false\ndata_dir=${toml(join(data, 'engine'))}\n[auth]\nenabled=true\n[tls]\nenabled=false\n[embedding]\nmode="neural"\nlocal_model_dir=${toml(model)}\n[cluster]\nenabled=false\n[rerank]\nenabled=false\n`;
  // No secret is read/copied by preparation. Native engine loads its own admin.key;
  // adoption links that exact file to the fixed operator-owned credential.
  const keyPath = join(project, XERJ_KEY);
  const engineKey = join(data, 'engine', 'admin.key');
  const engineScript = `#!/bin/sh\nset -eu\nkey=$(cat ${shellWord(engineKey)})\ncase "$key" in ''|*[!0-9a-fA-F]*) echo 'Invalid native engine credential.' >&2; exit 1;; esac\ntest "\${#key}" -eq 64 || { echo 'Invalid native engine credential.' >&2; exit 1; }\nbytes=$(wc -c < ${shellWord(engineKey)})\ntest "$bytes" -eq 64 || test "$bytes" -eq 65 || { echo 'Invalid native engine credential.' >&2; exit 1; }\ncmp -s ${shellWord(engineKey)} ${shellWord(keyPath)} || { echo 'Native credential selection mismatch.' >&2; exit 1; }\nunset key bytes\nexec ${engineArgv.map(shellWord).join(' ')}\n`;
  const watcherScript = (argv: string[]) =>
    `#!/bin/sh\nset -eu\nXERJ_API_KEY=$(cat ${shellWord(keyPath)})\nexport XERJ_API_KEY\nexec ${argv.map(shellWord).join(' ')}\n`;
  mkdirSync(output); // Exclusive bundle claim. Existing output blocks, never overwritten.
  const publish = (name: string, value: string) =>
    publishFreshFile(join(output, name), Buffer.from(value));
  publish('observed-collections-native.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  publish('engine.toml', engineConfig);
  publish(
    'commands.json',
    `${JSON.stringify(
      {
        engine: { argv: ['/bin/sh', join(output, 'engine.sh')], native_argv: engineArgv },
        watchers: watchers.map((w) => ({
          ...w,
          native_argv: w.argv,
          argv: ['/bin/sh', join(output, `watch-${w.prefix}.sh`)],
        })),
        environment,
        credential: XERJ_KEY,
        engine_key: engineKey,
        target,
      },
      null,
      2,
    )}\n`,
  );
  publish('engine.sh', engineScript);
  publish(
    engineUnit,
    `[Unit]\nDescription=Saivage private source observation engine\nStartLimitIntervalSec=120\nStartLimitBurst=3\nWants=${target}\nBefore=${target}\n${common}ExecStart=/bin/sh ${unitWord(join(output, 'engine.sh'))}\n`,
  );
  for (const [index, watcher] of watchers.entries()) {
    const script = `watch-${watcher.prefix}.sh`;
    publish(script, watcherScript(watcher.argv));
    publish(
      watcherUnits[index]!,
      `[Unit]\nDescription=Saivage native source watcher\nBindsTo=${engineUnit}\nAfter=${engineUnit}\nPartOf=${engineUnit} ${target}\nStartLimitIntervalSec=120\nStartLimitBurst=3\n${common}ExecStart=/bin/sh ${unitWord(join(output, script))}\n`,
    );
  }
  publish(
    target,
    `[Unit]\nDescription=Saivage source observation watchers\nBindsTo=${engineUnit}\nAfter=${engineUnit}\nPartOf=${engineUnit}\nWants=${watcherUnits.join(' ')}\n[Install]\nWantedBy=multi-user.target\n`,
  );
  publish(
    'ADOPT.txt',
    `Prepared only; no native process or index was created.\nKeep this bundle at its selected absolute path.\nInstall observed-collections-native.json at ${join(project, OBSERVED_DEPLOYMENT)}.\nInstall one private raw key at ${keyPath}; link ${join(data, 'engine', 'admin.key')} to it before starting.\nCreate native engine/watch directories under ${data}, owned by ${input.user}.\nInstall the .service/.target files and start ${target}.\nSee docs/runbook/observed-collections.md for dependency installation, credentials, limits and verification.\n`,
  );
  return { output, target, roots: roots.length };
}
