import { relative, resolve } from 'node:path';

import type { AgentName } from '../schemas/index.js';
import type { RecordProjection } from '../persistence/authored-record-files.js';
import type { RecordDefinition } from '../records/record-definition.js';
import type { CardService } from '../cards/card-api.js';
type CompleteRecordReader=Pick<CardService,'readRecordCurrent'|'readRecordVersion'>;
import { resolveContainedProjectPath } from './file-access-security.js';
import { buildScopedPathUrl, parseScopedPathUrl, type ParsedScopedPathUrl } from '../contracts/scoped-path-url.js';
import { cardTmpRelativePath, saivageWorkRelativePath, saivageWorkRoot } from '../persistence/layout.js';
import { parseRecordUrl, type ParsedRecordUrl } from '../contracts/record-mutation.js';

type ScopedPathMode = 'read' | 'write' | 'search';
type ScopedPathErrorFactory = (message: string) => Error;
type ScopedAgentContext = { cardId?: string; agentName?: AgentName };
type ResolvedRecordReadTarget=Readonly<{parsed:ParsedRecordUrl;definition:RecordDefinition;projection:RecordProjection|null}>;
type ResolvedScopedPath = { kind: 'project' | 'tmp' | 'system' | 'work'; absolutePath: string; relativePath: string; workRoot?: string } | ({ kind: 'record' } & ResolvedRecordReadTarget);

export interface ResolveScopedPathContext {
  projectRoot: string;
  agent?: ScopedAgentContext;
  fail: ScopedPathErrorFactory;
  records?: CompleteRecordReader;
}

export function validRecordSegment(value: string, label: string, raw: string, fail: ScopedPathErrorFactory): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.toLowerCase().includes('..')) throw fail(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}

function requireAgent(ctx: ResolveScopedPathContext, scheme: string): ScopedAgentContext {
  if (!ctx.agent?.agentName) throw ctx.fail(`${scheme} paths require an active named agent.`);
  return ctx.agent;
}

function rejectQueryAndFragment(raw: string, scheme: string, parsed: ParsedScopedPathUrl, fail: ScopedPathErrorFactory): void {
  if (parsed.query !== null) throw fail(`${scheme} URL '${raw}' must not include a query string.`);
  if (parsed.hadFragment) throw fail(`${scheme} URL '${raw}' must not include a fragment.`);
}

function resolveContained(ctx: ResolveScopedPathContext, rel: string, label: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(ctx.projectRoot, rel);
  if (!resolved.safe || !resolved.relativePath) throw ctx.fail(resolved.reason ?? `${label} must resolve inside the project root.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

function toolFacingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertRecordWrite(currentCardId: string | undefined, cardId: string, fail: ScopedPathErrorFactory): void {
  if (!currentCardId) throw fail('Record writes require an active card context.');
  if (cardId !== currentCardId) throw fail('Agents may write records only for their current card.');
}

export function resolveRecordWriteTarget(ctx: ResolveScopedPathContext, raw: string): ParsedRecordUrl & { agent: ScopedAgentContext; filename: string; recordUrl: string;definition:RecordDefinition } {
  const agent = requireAgent(ctx, 'record:///');
  let parsed: ParsedRecordUrl; try { parsed = parseRecordUrl(raw); } catch (error) { throw ctx.fail(toolFacingErrorMessage(error)); }
  if(parsed.version!==null)throw ctx.fail('Historical record URLs cannot be mutated.');
  const filename = parsed.name; const cardId = parsed.cardId;
  if(!ctx.records)throw ctx.fail('Record writes require an injected persistence reader.');
  const result=ctx.records.readRecordCurrent(cardId,filename);if(result.kind==='card-not-found')throw ctx.fail('Record not found.');
  return { ...parsed, agent, filename, recordUrl: parsed.currentUrl,definition:result.value.definition };
}

export function resolveRecordReadTarget(ctx: ResolveScopedPathContext, raw: string): ResolvedRecordReadTarget {
  if (!ctx.records) throw ctx.fail('Record reads require an injected persistence reader.');
  requireAgent(ctx, 'record:///');
  let parsed:ParsedRecordUrl;try{parsed=parseRecordUrl(raw);}catch(error){throw ctx.fail(toolFacingErrorMessage(error));}
  const result=parsed.version===null?ctx.records.readRecordCurrent(parsed.cardId,parsed.name):ctx.records.readRecordVersion(parsed.cardId,parsed.name,parsed.version);
  if(result.kind!=='found')throw ctx.fail('Record not found.');return Object.freeze({parsed,definition:result.value.definition,projection:result.value.projection});
}

export const scopedPathResolvers = {
  project(ctx: ResolveScopedPathContext, raw: string): ResolvedScopedPath {
    const parsed = parseScopedPathUrl(raw, 'project');
    rejectQueryAndFragment(raw, 'project', parsed, ctx.fail);
    return { kind: 'project', ...resolveContained(ctx, parsed.segments.join('/'), 'project path') };
  },
  system(ctx: ResolveScopedPathContext, raw: string): ResolvedScopedPath {
    const parsed = parseScopedPathUrl(raw, 'system');
    rejectQueryAndFragment(raw, 'system', parsed, ctx.fail);
    return { kind: 'system', absolutePath: resolve(`/${parsed.segments.join('/')}`), relativePath: buildScopedPathUrl('system', parsed.segments) };
  },
  tmp(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    const agent = requireAgent(ctx, 'tmp:///');
    const parsed = parseScopedPathUrl(raw, 'tmp');
    rejectQueryAndFragment(raw, 'tmp', parsed, ctx.fail);
    if (parsed.segments.length < 2) throw ctx.fail(`Invalid tmp URL '${raw}'.`);
    const [cardId, ...rest] = parsed.segments;
    if (mode === 'write' && cardId !== agent.cardId) throw ctx.fail('Card-scoped agents may write tmp files only for their current card.');
    return { kind: 'tmp', ...resolveContained(ctx, cardTmpRelativePath(cardId!, ...rest), 'tmp path') };
  },
  record(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') {
      throw ctx.fail('Record writes are logical mutations and cannot resolve to a filesystem path.');
    }
    return { kind: 'record', ...resolveRecordReadTarget(ctx, raw) };
  },
  work(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') throw ctx.fail('work:/// paths are read-only.');
    const parsed = parseScopedPathUrl(raw, 'work');
    rejectQueryAndFragment(raw, 'work', parsed, ctx.fail);
    const workRoot = saivageWorkRoot(ctx.projectRoot);
    return { kind: 'work', ...resolveContained(ctx, saivageWorkRelativePath(...parsed.segments), 'work path'), workRoot };
  },
} as const;

export type ScopedPathScheme = keyof typeof scopedPathResolvers;

export function workUrlFromAbsolutePath(projectRoot: string, absolutePath: string): string {
  const workRoot = saivageWorkRoot(projectRoot);
  const rel = relative(workRoot, absolutePath).replace(/\\/g, '/');
  const contained = resolveContainedProjectPath(workRoot, rel === '' ? '.' : rel);
  if (!contained.safe || !contained.relativePath || contained.relativePath.startsWith('../')) throw new Error(`Path '${absolutePath}' is not under the work root.`);
  return buildScopedPathUrl('work', contained.relativePath === '.' ? [] : contained.relativePath.split('/'));
}

export function parseScopedPathScheme(raw: string): ScopedPathScheme | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!match) return null;
  const scheme = match[1] as ScopedPathScheme;
  if (!(scheme in scopedPathResolvers)) throw new Error(`Unsupported scoped URL scheme '${match[1]}'.`);
  if (!raw.startsWith(`${scheme}:///`)) throw new Error(`Invalid ${scheme} URL '${raw}' (expected ${scheme}:///).`);
  return scheme;
}
