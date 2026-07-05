import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, MAX_COMMAND_TIMEOUT_MS, truncateCommandOutput } from '../runtime/command-policy.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';
import type { AgentRole, ProcessRecord } from '../schemas/index.js';
import { resolveContainedProjectPath } from '../workspace/index.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

export interface ProcessProviderContext {
  readonly projectRoot: string;
  readonly processRunner: ProcessRunner;
  readonly ownerId: string;
  readonly cardId?: string;
  readonly agentRole?: AgentRole;
  readonly ownerKind: 'agent' | 'operator' | 'runtime';
  readonly launchReason?: string;
  readonly runtimeGate?: RuntimeGate;
}

function failureFromError(err: unknown): ToolResult {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

function timeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 0) throw new Error('timeout_ms must be a non-negative integer.');
  return Math.min(value, MAX_COMMAND_TIMEOUT_MS);
}

function scopedCwd(projectRoot: string, raw: string | undefined): string {
  if (!raw) return projectRoot;
  if (raw.startsWith('system://')) {
    const target = raw.slice('system://'.length);
    return target ? resolve(target) : '/';
  }
  const projectPath = raw.startsWith('project://') ? raw.slice('project://'.length) : raw;
  const resolved = resolveContainedProjectPath(projectRoot, projectPath || '.');
  if (!resolved.safe) throw new Error(resolved.reason ?? 'cwd must resolve inside the project root.');
  return resolved.absolutePath;
}

function logText(path: string | null | undefined): string {
  if (!path) return '';
  try {
    return truncateCommandOutput(readFileSync(path, 'utf8'), DEFAULT_MAX_OUTPUT_BYTES);
  } catch {
    return '';
  }
}

function assertOwned(ctx: ProcessProviderContext, processId: string): ProcessRecord {
  const record = ctx.processRunner.get(processId);
  if (!record) throw new Error(`Unknown process '${processId}'.`);
  if (record.owner_id !== ctx.ownerId) throw new Error(`Process '${processId}' is not owned by this activation or session.`);
  return record;
}

function processResult(ctx: ProcessProviderContext, processId: string): Record<string, unknown> {
  const record = assertOwned(ctx, processId);
  return {
    process_id: record.id,
    exit_code: record.exit_code ?? null,
    status: record.status,
    stdout: logText(record.stdout_path),
    stderr: logText(record.stderr_path),
    truncated: false,
    log_path: `.saivage-work/processes/${record.id}/combined.log`,
  };
}

const runCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().optional(),
  inactivity_timeout_ms: z.number().int().optional(),
  wait: z.boolean().optional(),
}).strict();

const waitProcessSchema = z.object({
  process_id: z.string().min(1),
  timeout_ms: z.number().int().optional(),
}).strict();

const killProcessSchema = z.object({
  process_id: z.string().min(1),
}).strict();

export function createProcessProvider(ctx: ProcessProviderContext): ToolProvider {
  const launchReason = ctx.launchReason ?? `${ctx.agentRole ?? 'agent'} process provider run_command`;
  return {
    providerName: 'process',
    tools: [
      defineTool({
        name: 'run_command',
        description: 'Run a shell command. Set wait=false to start a background process for later wait_process or kill_process.',
        inputSchema: runCommandSchema,
        executor: async (args) => {
          try {
            if (ctx.ownerKind !== 'operator') await ctx.runtimeGate?.waitUntilOpen();
            const record = ctx.processRunner.spawn({
              command: args.command,
              cardId: ctx.cardId ?? ctx.ownerId,
              ownerId: ctx.ownerId,
              agentSessionId: ctx.ownerId,
              cwd: scopedCwd(ctx.projectRoot, args.cwd),
              requiredForCardCompletion: true,
              ownerKind: ctx.ownerKind,
              launchReason,
              backgroundPolicy: args.wait === false ? undefined : 'foreground',
            });
            if (args.wait === false) return { success: true, data: { process_id: record.id, running: true } };
            await ctx.processRunner.wait(record.id, timeoutMs(args.timeout_ms));
            return { success: true, data: processResult(ctx, record.id) };
          } catch (err) {
            return failureFromError(err);
          }
        },
      }),
      defineTool({
        name: 'wait_process',
        description: 'Wait for a process owned by this activation or session. Use timeout_ms=0 for non-blocking inspection.',
        inputSchema: waitProcessSchema,
        executor: async (args) => {
          try {
            const current = assertOwned(ctx, args.process_id);
            if (args.timeout_ms === 0 && current.status === 'running') return { success: true, data: { process_id: args.process_id, still_running: true } };
            const result = await ctx.processRunner.wait(args.process_id, timeoutMs(args.timeout_ms));
            if (result.timedOut) return { success: true, data: { process_id: args.process_id, still_running: true } };
            return { success: true, data: processResult(ctx, args.process_id) };
          } catch (err) {
            return failureFromError(err);
          }
        },
      }),
      defineTool({
        name: 'kill_process',
        description: 'Signal a process owned by this activation or session. Defaults to SIGTERM.',
        inputSchema: killProcessSchema,
        executor: async (args) => {
          try {
            assertOwned(ctx, args.process_id);
            const record = await ctx.processRunner.kill(args.process_id, 'tool kill_process');
            if (!record) throw new Error(`Unknown process '${args.process_id}'.`);
            return { success: true, data: { process_id: args.process_id, terminated: true } };
          } catch (err) {
            return failureFromError(err);
          }
        },
      }),
    ],
  };
}
