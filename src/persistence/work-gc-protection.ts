import { z } from 'zod';
import type { QualityToolBindings } from '../schemas/index.js';

type QualityConfig = NonNullable<
  QualityToolBindings[Exclude<keyof QualityToolBindings, 'format_version'>]
>;

export function* workGcQualityPaths(config: QualityConfig): Generator<string> {
  yield config.cwd;
  yield config.native_config;
  yield* config.source_paths;
  yield* config.exclusions;
  if ('ruff_binary' in config) yield config.ruff_binary;
  else {
    yield config.node_binary;
    yield config.eslint_module;
    if ('tsconfig' in config) {
      yield config.tsconfig;
      yield config.typescript_eslint_module;
      yield config.typescript_module;
    }
  }
}

export type WorkGcReference =
  | { readonly kind: 'content'; readonly value: unknown }
  | {
      readonly kind: 'address';
      readonly value: string;
      readonly syntax: 'native' | 'locator' | 'cardwork' | 'display';
      readonly required?: boolean;
    }
  | { readonly kind: 'glob'; readonly directory: string; readonly pattern: string };

const content = (value: unknown): WorkGcReference => ({ kind: 'content', value });
const locator = /^(?:cardwork|project|system|work|tmp|file):/iu;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function* address(
  value: unknown,
  syntax?: Extract<WorkGcReference, { kind: 'address' }>['syntax'],
  required = false,
): Generator<WorkGcReference> {
  if (typeof value !== 'string') return;
  if (syntax !== 'native' && syntax !== 'cardwork' && value.startsWith('record:///')) return;
  if (syntax === undefined) {
    if (locator.test(value)) syntax = 'locator';
    else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return;
    else syntax = 'native';
  }
  yield { kind: 'address', value, syntax, ...(required ? { required } : {}) };
}

function* callReferences(name: string, args: unknown): Generator<WorkGcReference> {
  switch (name) {
    case 'read':
    case 'view_image':
    case 'edit':
    case 'write': {
      const { path, ...rest } = object(args);
      yield* address(path);
      yield content(rest);
      return;
    }
    case 'webfetch': {
      const { save_as, ...rest } = object(args);
      yield* address(save_as);
      yield content(rest);
      return;
    }
    case 'grep': {
      const { path, pattern: _pattern, include, ...rest } = object(args);
      yield* address(path);
      if (!(typeof path === 'string' && path.startsWith('record:///'))) yield content(include);
      yield content(rest);
      return;
    }
    case 'glob': {
      const { directory, pattern, ...rest } = object(args);
      if (
        typeof directory === 'string' &&
        !directory.startsWith('record:///') &&
        typeof pattern === 'string'
      )
        yield { kind: 'glob', directory, pattern };
      yield content(rest);
      return;
    }
    case 'run_command': {
      const { command: _command, cwd, ...rest } = z.record(z.unknown()).parse(args);
      if (
        typeof cwd === 'string' &&
        (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(cwd) || /^(?:project|system):/u.test(cwd))
      )
        yield* address(cwd, /^(?:project|system):\/\//u.test(cwd) ? 'locator' : 'native');
      yield content(rest);
      return;
    }
    default:
      yield content(args);
  }
}

function* writeAddress(
  value: unknown,
  destination: unknown,
  executed: boolean,
): Generator<WorkGcReference> {
  if (destination === 'cardwork_url') yield* address(value, 'cardwork', executed);
  else if (destination === 'project_relative') yield* address(value, 'native');
  else yield* address(value);
}

function* resultData(tool: string, value: unknown, executed: boolean): Generator<WorkGcReference> {
  switch (tool) {
    case 'glob':
    case 'grep': {
      const { matches, ...rest } = object(value);
      const { items } = object(matches);
      if (Array.isArray(items))
        for (const item of items) {
          if (tool === 'glob') yield* address(item, 'display');
          else {
            yield* address(object(item).path, 'display');
            yield content(object(item).preview);
          }
        }
      yield content(rest);
      return;
    }
    case 'read':
    case 'edit': {
      const { path, entries: _entries, ...rest } = object(value);
      yield* address(path, 'display');
      yield content(rest);
      return;
    }
    case 'view_image': {
      const { source_path, ...rest } = object(value);
      yield* address(source_path, 'display');
      yield content(rest);
      return;
    }
    case 'write': {
      const { target, destination_kind, ...rest } = object(value);
      yield* writeAddress(target, destination_kind, executed);
      yield content(rest);
      return;
    }
    case 'webfetch': {
      const { saved_as, write, ...rest } = object(value);
      const branch = object(write);
      if (branch.kind === 'workspace_file') {
        const { target, destination_kind, ...fields } = object(branch.data);
        yield* writeAddress(saved_as, destination_kind, executed);
        yield* writeAddress(target, destination_kind, executed);
        yield content(fields);
      } else yield content(write);
      yield content(rest);
      return;
    }
    case 'apply_patch': {
      const { changed_files, ...rest } = object(value);
      if (Array.isArray(changed_files))
        for (const path of changed_files) yield* address(path, 'native');
      yield content(rest);
      return;
    }
    default:
      yield content(value);
  }
}

/** GC payload selection, independent of ordinary conversation/model validation. */
export function* rowWorkReferences(value: unknown): Generator<WorkGcReference> {
  const { kind } = z.object({ kind: z.string() }).parse(value);
  const row = value as Record<string, unknown>;
  switch (kind) {
    case 'text':
    case 'record_prompt':
    case 'model_repair':
      yield content(z.string().parse(row.content));
      return;
    case 'tool_call': {
      const call = z
        .object({
          tool_calls: z
            .array(
              z.object({
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .length(1),
        })
        .parse(JSON.parse(z.string().parse(row.content))).tool_calls[0]!.function;
      if (z.string().parse(row.tool) !== call.name)
        throw new Error('Ambiguous GC tool-call owner.');
      yield* callReferences(call.name, JSON.parse(call.arguments));
      return;
    }
    case 'tool_result': {
      const result = z
        .object({
          success: z.boolean(),
          error: z.unknown(),
          data: z.unknown(),
          content: z.unknown(),
        })
        .parse(JSON.parse(z.string().parse(row.content)));
      if (!result.success) {
        yield content(z.string().parse(result.error));
        yield content(result.data);
        return;
      }
      const tool = z.string().parse(row.tool);
      if (tool === 'run_command' || tool === 'wait_process' || tool === 'kill_process') {
        const data = z
          .object({
            status: z.enum(['running', 'exited', 'killed', 'failed']),
            stdout_complete: z.boolean(),
            stderr_complete: z.boolean(),
            stdout: z.string(),
            stderr: z.string(),
          })
          .parse(result.data);
        yield content([data.stdout, data.stderr]);
        const raw = result.data as Record<string, unknown>;
        if (data.status === 'running' || !data.stdout_complete)
          yield* address(z.string().parse(raw.stdout_url), 'locator');
        if (data.status === 'running' || !data.stderr_complete)
          yield* address(z.string().parse(raw.stderr_url), 'locator');
      } else {
        yield* resultData(
          tool,
          result.data,
          object(row.context_policy).settlement_origin === 'executed',
        );
        if (result.content !== undefined)
          for (const value of z.custom<unknown[]>(Array.isArray).parse(result.content)) {
            const block = z
              .object({
                type: z.enum(['text', 'image']),
                text: z.unknown(),
                image: z.unknown(),
              })
              .parse(value);
            yield content(block.type === 'text' ? z.string().parse(block.text) : block.image);
          }
      }
      return;
    }
    case 'activity':
    case 'record_observation':
    case 'model_issue':
    case 'provider_private':
    case 'model_recovered':
    case 'content_policy_refusal':
    case 'content_policy_retry':
      return;
    default:
      throw new Error('Unknown GC conversation row kind.');
  }
}
