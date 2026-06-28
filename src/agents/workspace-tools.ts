import { isAbsolute, relative, resolve } from 'node:path';
import { toolDefinitionByName } from '../tools/definitions/index.js';
import type { AgentRole } from '../tools/tool-catalog.js';
export {
  READ_ONLY_WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
} from '../tools/definitions/index.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  truncateCommandOutput,
} from '../runtime/command-policy.js';
import { processApi } from '../runtime/process-api.js';
import { applyProjectPatch, editProject, globProject, grepProject, readProject, writeProject } from '../tools/project-file-tools.js';

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
  agentRole?: AgentRole;
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

export async function processWorkspaceToolCall(
  name: string,
  rawArguments: string,
  context: WorkspaceToolContext,
): Promise<unknown> {
  const args = parseWorkspaceArgs(name, rawArguments);

  if (name === 'read') {
    return readProject(context, args as { path: string; offset?: number; limit?: number; read_mode?: 'auto' | 'text' | 'multimodal' });
  }

  if (name === 'write') {
    return writeProject(context, args as { path: string; content: string });
  }

  if (name === 'glob') {
    return globProject(context, args as { directory: string; pattern: string; max_results?: number });
  }

  if (name === 'grep') {
    return grepProject(context, args as { pattern: string; path?: string; include?: string; max_results?: number });
  }

  if (name === 'edit') {
    return editProject(context, args as { path: string; old_string: string; new_string: string; replace_all?: boolean });
  }

  if (name === 'apply_patch') {
    return applyProjectPatch(context, args as { patch: string });
  }

  if (name === 'wait_for_process') {
    const { waitProcess } = await getProcessRunner();
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
      output: truncateOutput(processApi(context.projectRoot).tail(waitResult.id, 200)),
    };
  }

  if (name === 'kill_process') {
    const processId = typeof args.processId === 'string' ? args.processId.trim() : '';
    if (!processId) throw new Error('kill_process requires a processId.');
    const signal = typeof args.signal === 'string' && args.signal.trim() ? args.signal.trim() as NodeJS.Signals : 'SIGTERM';
    const processes = processApi(context.projectRoot);
    const record = await processes.terminate(processId, signal);
    if (!record) throw new Error(`Unknown process '${processId}'.`);
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exit_code ?? null,
      signal: record.signal ?? null,
      noOp: record.status !== 'running' && !processes.getForRuntime(processId)?.pid,
      logFiles: processLogFiles(record.id),
      output: truncateOutput(processes.tail(record.id, 200)),
    };
  }

  if (name === 'run_project_command' || name === 'start_and_wait') {
    const { startAndWait } = await getProcessRunner();
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
      output: truncateOutput(processApi(context.projectRoot).tail(waitResult.id, 200)),
    };
  }

  throw new Error(`Unknown workspace tool '${name}'.`);
}
