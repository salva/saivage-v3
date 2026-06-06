import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readProjectFileAtomic, writeFileAtomic } from '../persistence/index.js';
import { isWriteBlocked } from '../workspace/index.js';
import { toolDefinitionByName } from '../tools/definitions/index.js';
export {
  READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
} from '../tools/definitions/index.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_LIST_RESULTS,
  truncateCommandOutput,
} from '../runtime/command-policy.js';

const DEFAULT_MAX_RESULTS = 200;

const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  '.saivage',
  '.saivage-work',
  'dist',
  'build',
  '__pycache__',
]);

type ProcessRunnerModule = typeof import('../runtime/process-runner.js');

let processRunnerModulePromise: Promise<ProcessRunnerModule> | null = null;

function getProcessRunner(): Promise<ProcessRunnerModule> {
  processRunnerModulePromise ??= import('../runtime/process-runner.js');
  return processRunnerModulePromise;
}

export interface WorkspaceToolContext {
  projectRoot: string;
  sessionId: string;
  cardId?: string;
  goalId?: string;
}

function truncateOutput(value: string): string {
  return truncateCommandOutput(value, DEFAULT_MAX_OUTPUT_BYTES);
}

function processLogFiles(processId: string): { combined: string; stdout: string; stderr: string } {
  const base = `.saivage-work/processes/${processId}`;
  return {
    combined: `${base}/combined.log`,
    stdout: `${base}/stdout.log`,
    stderr: `${base}/stderr.log`,
  };
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Workspace tool arguments must be valid JSON.');
  }
}

function parseWorkspaceArgs(name: string, raw: string): Record<string, unknown> {
  const definition = toolDefinitionByName(name);
  if (!definition?.workspace) throw new Error(`Unknown workspace tool '${name}'.`);
  const parsed = definition.input.parse(parseArgs(raw));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function projectRelativePath(projectRoot: string, requested: string | undefined, label: string): string {
  const value = (requested ?? '').trim();
  if (!value) return '';

  const root = resolve(projectRoot);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside the project root.`);
  }
  return rel === '' ? '.' : rel;
}

function projectAbsolutePath(projectRoot: string, requested: string | undefined, label: string): string {
  const rel = projectRelativePath(projectRoot, requested, label);
  return rel === '.' ? resolve(projectRoot) : resolve(projectRoot, rel);
}

function assertWritableProjectPath(relPath: string): void {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized === '.' || normalized.endsWith('/')) {
    throw new Error('write_project_file requires a file path, not a directory.');
  }
  if (
    normalized === '.saivage' ||
    normalized === '.saivage-work' ||
    normalized.startsWith('.saivage/') ||
    normalized.startsWith('.saivage-work/')
  ) {
    throw new Error('write_project_file cannot modify Saivage internal state directories.');
  }
  if (isWriteBlocked(normalized)) {
    throw new Error(`write_project_file is blocked for ${normalized}.`);
  }
}

function listProjectFiles(projectRoot: string, requestedPath: string | undefined, maxResultsArg: unknown): string[] {
  const root = resolve(projectRoot);
  const start = projectAbsolutePath(root, requestedPath, 'list path');
  const requestedLimit = Number.isInteger(maxResultsArg) ? Number(maxResultsArg) : DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(Math.max(requestedLimit, 1), MAX_LIST_RESULTS);
  const results: string[] = [];

  function visit(dir: string): void {
    if (results.length >= maxResults) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }

  if (!existsSync(start)) return [];
  const stat = statSync(start);
  if (stat.isFile()) return [relative(root, start).replace(/\\/g, '/')];
  visit(start);
  return results;
}

export async function processWorkspaceToolCall(
  name: string,
  rawArguments: string,
  context: WorkspaceToolContext,
): Promise<unknown> {
  const args = parseWorkspaceArgs(name, rawArguments);

  if (name === 'list_project_files') {
    const files = listProjectFiles(
      context.projectRoot,
      typeof args.path === 'string' ? args.path : undefined,
      args.maxResults,
    );
    return { projectRoot: context.projectRoot, files };
  }

  if (name === 'read_project_file') {
    const relPath = projectRelativePath(context.projectRoot, typeof args.path === 'string' ? args.path : '', 'read path');
    if (!relPath || relPath === '.') throw new Error('read_project_file requires a file path.');
    const content = readProjectFileAtomic(context.projectRoot, relPath, { redactSecrets: true });
    return { path: relPath, content };
  }

  if (name === 'write_project_file') {
    const relPath = projectRelativePath(context.projectRoot, typeof args.path === 'string' ? args.path : '', 'write path');
    assertWritableProjectPath(relPath);
    const content = typeof args.content === 'string' ? args.content : '';
    writeFileAtomic(resolve(context.projectRoot, relPath), content);
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf8'), written: true };
  }


  if (name === 'wait_for_process') {
    const { waitProcess, tailOutput } = await getProcessRunner();
    const processId = typeof args.processId === 'string' ? args.processId.trim() : '';
    if (!processId) throw new Error('wait_for_process requires a processId.');
    const requestedTimeout = Number.isInteger(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1), MAX_COMMAND_TIMEOUT_MS);
    const waitResult = await waitProcess(context.projectRoot, processId, timeoutMs);
    return {
      id: waitResult.id,
      status: waitResult.status,
      exitCode: waitResult.exitCode,
      timedOut: waitResult.timedOut,
      logFiles: processLogFiles(waitResult.id),
      output: truncateOutput(tailOutput(context.projectRoot, waitResult.id, 200)),
    };
  }

  if (name === 'kill_process') {
    const { killProcess, tailOutput, getProcess } = await getProcessRunner();
    const processId = typeof args.processId === 'string' ? args.processId.trim() : '';
    if (!processId) throw new Error('kill_process requires a processId.');
    const signal = typeof args.signal === 'string' && args.signal.trim() ? args.signal.trim() as NodeJS.Signals : 'SIGTERM';
    const record = await killProcess(context.projectRoot, processId, signal);
    if (!record) throw new Error(`Unknown process '${processId}'.`);
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exit_code ?? null,
      signal: record.signal ?? null,
      noOp: record.status !== 'running' && !getProcess(context.projectRoot, processId)?.pid,
      logFiles: processLogFiles(record.id),
      output: truncateOutput(tailOutput(context.projectRoot, record.id, 200)),
    };
  }

  if (name === 'run_project_command' || name === 'start_and_wait') {
    const { startAndWait, tailOutput } = await getProcessRunner();
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) throw new Error('run_project_command requires a non-empty command.');
    const cwd = projectAbsolutePath(context.projectRoot, typeof args.cwd === 'string' ? args.cwd : undefined, 'cwd');
    const requestedTimeout = Number.isInteger(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1), MAX_COMMAND_TIMEOUT_MS);
    const waitResult = await startAndWait(
      context.projectRoot,
      command,
      {
        cardId: context.cardId ?? 'unknown-card',
        goalId: context.goalId,
        agentSessionId: context.sessionId,
        cwd,
        requiredForCardCompletion: true,
        ownerKind: 'agent',
        launchReason: 'agent workspace tool',
      },
      timeoutMs,
    );
    return {
      id: waitResult.id,
      status: waitResult.status,
      exitCode: waitResult.exitCode,
      timedOut: waitResult.timedOut,
      logFiles: processLogFiles(waitResult.id),
      output: truncateOutput(tailOutput(context.projectRoot, waitResult.id, 200)),
    };
  }

  throw new Error(`Unknown workspace tool '${name}'.`);
}
