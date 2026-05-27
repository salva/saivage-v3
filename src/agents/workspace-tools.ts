import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from './llm-contracts.js';
import { readProjectFileAtomic, writeFileAtomic } from '../persistence/index.js';
import { isWriteBlocked } from '../workspace/index.js';

const DEFAULT_MAX_RESULTS = 200;
const MAX_LIST_RESULTS = 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const MAX_COMMAND_TIMEOUT_MS = 600000;
const MAX_TOOL_OUTPUT_CHARS = 20000;

const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  '.saivage',
  '.saivage-work',
  'dist',
  'build',
  '__pycache__',
]);

export const READ_ONLY_WORKSPACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_project_files',
      description: 'List files under the Saivage project root. Paths are project-relative; Saivage internal state directories are omitted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative directory to list. Defaults to the project root.' },
          maxResults: { type: 'integer', description: 'Maximum file paths to return. Defaults to 200; capped at 1000.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: 'Read a project file safely. Paths must resolve inside the project root; blocked Saivage credential files cannot be read and secrets are redacted where appropriate.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path to read.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

export const WORKSPACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  {
    type: 'function',
    function: {
      name: 'write_project_file',
      description: 'Create or replace a project file. Paths must resolve inside the project root and may not write Saivage internal state or blocked credential/runtime files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'wait_for_process',
      description: 'Wait for a previously-started Saivage process by id. Already-terminal processes return their cached terminal status.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'Process id returned by run_project_command or start_and_wait.' },
          timeoutMs: { type: 'integer', description: 'Optional wait timeout in milliseconds; capped at 600000.' },
        },
        required: ['processId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Request termination of a Saivage process by id. Already-terminal processes are returned unchanged.',
      parameters: {
        type: 'object',
        properties: {
          processId: { type: 'string', description: 'Process id to terminate.' },
          signal: { type: 'string', description: 'Signal to send; defaults to SIGTERM.' },
        },
        required: ['processId'],
        additionalProperties: false,
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'start_and_wait',
      description: 'Run a shell command and wait for completion using the durable Saivage process runner.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: { type: 'string', description: 'Optional project-relative working directory. Defaults to the project root.' },
          timeoutMs: { type: 'integer', description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_project_command',
      description: 'Run a shell command from the project root or a project-relative working directory. Output is captured through the Saivage process runner.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: { type: 'string', description: 'Optional project-relative working directory. Defaults to the project root.' },
          timeoutMs: { type: 'integer', description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

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
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated]`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
  const args = parseArgs(rawArguments);

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
      output: truncateOutput(tailOutput(context.projectRoot, waitResult.id, 200)),
    };
  }

  throw new Error(`Unknown workspace tool '${name}'.`);
}