import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildScopedPathUrl, parseScopedPathUrl } from '../contracts/scoped-path-url.js';
import type { ProcessToolResult } from '../contracts/operator-api-processes.js';
import { killProcessInputSchema, runCommandInputSchema, waitProcessInputSchema } from '../contracts/builtin-tool-inputs.js';
import { redactForOutbound } from '../redaction/index.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../runtime/command-policy.js';
import type { ManagedProcessScope, ProcessCategory, ProcessRunner } from '../runtime/process-runner.js';
import type { AgentRole, ProcessRecord } from '../schemas/index.js';
import { parseScopedPathScheme, resolveContainedProjectPath } from '../workspace/index.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

export interface ProcessProviderContext {
  readonly projectRoot: string;
  readonly processRunner: ProcessRunner;
  readonly ownerId: string;
  readonly cardId?: string;
  readonly agentRole?: AgentRole;
  readonly ownerKind: 'agent' | 'operator' | 'runtime';
  readonly directScope: ManagedProcessScope;
  readonly category: ProcessCategory;
  readonly launchReason?: string;
}

function failureFromError(err: unknown): ToolResult {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || err === signal.reason;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Tool invocation was interrupted.');
}

function waitForProcess(ctx: ProcessProviderContext, processId: string, timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Tool invocation was interrupted.'));
      return;
    }
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Tool invocation was interrupted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    ctx.processRunner.wait(processId, timeoutMs).then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: result.timedOut });
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function timeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 0) throw new Error('timeout_ms must be a non-negative integer.');
  return Math.min(value, MAX_COMMAND_TIMEOUT_MS);
}

function scopedCwd(projectRoot: string, raw: string | undefined): string {
  if (!raw) return projectRoot;
  const scheme = parseScopedPathScheme(raw);
  if (scheme === 'project' || scheme === 'system') {
    const parsed = parseScopedPathUrl(raw, scheme);
    if (parsed.query !== null || parsed.hadFragment) throw new Error(`Invalid ${scheme} cwd '${raw}'.`);
    if (scheme === 'system') return resolve(`/${parsed.segments.join('/')}`);
    const resolved = resolveContainedProjectPath(projectRoot, parsed.segments.join('/') || '.');
    if (!resolved.safe) throw new Error(resolved.reason ?? 'cwd must resolve inside the project root.');
    return resolved.absolutePath;
  }
  if (scheme !== null) throw new Error(`Scoped URL scheme '${scheme}' is not supported for cwd.`);
  const resolved = resolveContainedProjectPath(projectRoot, raw);
  if (!resolved.safe) throw new Error(resolved.reason ?? 'cwd must resolve inside the project root.');
  return resolved.absolutePath;
}

function logBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

function assertOwned(ctx: ProcessProviderContext, processId: string): ProcessRecord {
  const record = ctx.processRunner.get(processId);
  if (!record) throw new Error(`Unknown process '${processId}'.`);
  if (record.owner_id !== ctx.ownerId) throw new Error(`Process '${processId}' is not owned by this activation or session.`);
  return record;
}

function processResult(ctx: ProcessProviderContext, processId: string): ProcessToolResult {
  const record = assertOwned(ctx, processId);
  const logSegments = record.card_id
    ? ['cards', record.card_id, 'processes', record.id]
    : ['processes', record.id];
  return redactForOutbound({ source: 'process-view', value: {
    process_id: record.id,
    exit_code: record.exit_code ?? null,
    status: record.status,
    stdout_url: buildScopedPathUrl('work', [...logSegments, 'stdout.log']),
    stderr_url: buildScopedPathUrl('work', [...logSegments, 'stderr.log']),
    stdout_bytes: logBytes(record.stdout_path),
    stderr_bytes: logBytes(record.stderr_path),
  } });
}

export function createProcessProvider(ctx: ProcessProviderContext): ToolProvider {
  const launchReason = ctx.launchReason ?? `${ctx.agentRole ?? 'agent'} process provider run_command`;
  return {
    providerName: 'process',
    async cleanup(reason) {
      const label = reason.kind === 'activation_settled'
        ? `activation settled: ${reason.status}`
        : reason.kind === 'session_closed'
          ? 'session closed'
          : 'runtime shutdown';
      const report = await ctx.processRunner.closeAndTerminateDirectScope({ directScope: ctx.directScope, category: ctx.category, reason: label, graceMs: 5000 });
      if (report.failed.length > 0) throw new Error(report.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
    },
    tools: [
      defineTool({
        name: 'run_command',
        description: 'Run a Bash command. Results use process_id, exit_code, status, stdout_url, stderr_url, and byte counts; pass work:/// stdout_url/stderr_url to read or grep to page through output. Set wait=false to start a background process for later wait_process or kill_process.',
        inputSchema: runCommandInputSchema,
        executor: async (args, signal, invocation) => {
          try {
            throwIfAborted(signal);
            const record = ctx.processRunner.spawn({
              command: args.command,
              directScope: ctx.directScope,
              category: ctx.category,
              cardId: ctx.cardId ?? null,
              ownerId: ctx.ownerId,
              agentSessionId: ctx.ownerId,
              cwd: scopedCwd(ctx.projectRoot, args.cwd),
              requiredForCardCompletion: ctx.cardId ? true : false,
              ownerKind: ctx.ownerKind,
              launchReason,
              backgroundPolicy: args.wait === false ? undefined : 'foreground',
            });
            if (args.wait === false) return { success: true, data: processResult(ctx, record.id) };
            try {
              const pending = waitForProcess(ctx, record.id, timeoutMs(args.timeout_ms), signal);
              await (invocation ? invocation.waits.waitProcess(record.id, pending) : pending);
            } catch (err) {
              await ctx.processRunner.kill(record.id, { directScope: ctx.directScope, category: ctx.category, reason: 'tool invocation interrupted', graceMs: 5000 });
              if (isAbortError(err, signal)) return { success: true, data: processResult(ctx, record.id) };
              throw err;
            }
            return { success: true, data: processResult(ctx, record.id) };
          } catch (err) {
            if (isAbortError(err, signal)) throw err;
            return failureFromError(err);
          }
        },
      }),
      defineTool({
        name: 'wait_process',
        description: 'Wait for a process owned by this activation or session. Results use process_id, exit_code, status, stdout_url, stderr_url, and byte counts; pass the work:/// output URLs to read or grep. Use timeout_ms=0 for non-blocking inspection.',
        inputSchema: waitProcessInputSchema,
        executor: async (args, signal, invocation) => {
          try {
            throwIfAborted(signal);
            const current = assertOwned(ctx, args.process_id);
            if (args.timeout_ms === 0 && current.status === 'running') return { success: true, data: processResult(ctx, args.process_id) };
            if (current.status !== 'running') return { success: true, data: processResult(ctx, args.process_id) };
            const pending = waitForProcess(ctx, args.process_id, timeoutMs(args.timeout_ms), signal);
            const result = await (invocation ? invocation.waits.waitProcess(args.process_id, pending) : pending);
            if (result.timedOut) return { success: true, data: processResult(ctx, args.process_id) };
            return { success: true, data: processResult(ctx, args.process_id) };
          } catch (err) {
            if (isAbortError(err, signal)) throw err;
            return failureFromError(err);
          }
        },
      }),
      defineTool({
        name: 'kill_process',
        description: 'Signal a process owned by this activation or session. Results use process_id, exit_code, status, stdout_url, stderr_url, and byte counts; pass the work:/// output URLs to read or grep.',
        inputSchema: killProcessInputSchema,
        executor: async (args) => {
          try {
            assertOwned(ctx, args.process_id);
            const record = await ctx.processRunner.kill(args.process_id, { directScope: ctx.directScope, category: ctx.category, reason: 'tool kill_process' });
            if (!record) throw new Error(`Unknown process '${args.process_id}'.`);
            return { success: true, data: processResult(ctx, args.process_id) };
          } catch (err) {
            return failureFromError(err);
          }
        },
      }),
    ],
  };
}
