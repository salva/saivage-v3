import { relative, resolve } from 'node:path';

import type { AgentName } from '../schemas/index.js';
import { AuthoredRecordDefinitionNotFoundError, AuthoredRecordNotFoundError, type RecordProjection } from '../persistence/authored-record-files.js';
import { cardIdSchema } from '../schemas/index.js';
import type { RecordDefinition } from '../records/record-definition.js';
export type AuthoredRecordReader = { current(cardId: string, filename: string): RecordProjection; historical(cardId: string, filename: string, version: number): RecordProjection;definition(cardId:string,filename:string):RecordDefinition };
import { resolveContainedProjectPath } from './file-access-security.js';
import { buildScopedPathUrl, parseScopedPathUrl, type ParsedScopedPathUrl } from '../contracts/scoped-path-url.js';
import { cardTmpRelativePath, saivageWorkRelativePath, saivageWorkRoot } from '../persistence/layout.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { parseRecordMutationUrl, type ParsedRecordMutationTarget } from '../contracts/record-mutation.js';

export type ScopedPathMode = 'read' | 'write' | 'search';
export type ScopedPathErrorFactory = (message: string) => Error;
export type ScopedAgentContext = { cardId?: string; agentName?: AgentName };
export type ResolvedScopedPath = { kind: 'project' | 'tmp' | 'system' | 'work'; absolutePath: string; relativePath: string; workRoot?: string } | ({ kind: 'record' } & RecordProjection);

export interface ResolveScopedPathContext {
  projectRoot: string;
  agent?: ScopedAgentContext;
  fail: ScopedPathErrorFactory;
  records?: AuthoredRecordReader;
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

function readRecordOrNotFound(ctx: ResolveScopedPathContext, read: () => RecordProjection): RecordProjection {
  try { return read(); }
  catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof AuthoredRecordNotFoundError || error instanceof AuthoredRecordDefinitionNotFoundError) throw ctx.fail('Record not found.');
    throw error;
  }
}

function recordDefinitionOrNotFound(ctx: ResolveScopedPathContext, cardId: string, filename: string): RecordDefinition {
  try { return ctx.records!.definition(cardId, filename); }
  catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof AuthoredRecordNotFoundError || error instanceof AuthoredRecordDefinitionNotFoundError) throw ctx.fail('Record not found.');
    throw error;
  }
}

export function assertRecordWrite(agentName: AgentName | undefined, currentCardId: string | undefined, cardId: string, definition:RecordDefinition, _expectedHead: number | 'absent', fail: ScopedPathErrorFactory): void {
  if (!currentCardId) throw fail('Record writes require an active card context.');
  if (cardId !== currentCardId) throw fail('Agents may write records only for their current card.');
  if (!agentName || !definition.writers.includes(agentName)) throw fail(`${agentName} cannot write record '${definition.filename}'.`);
}

export function resolveRecordWriteTarget(ctx: ResolveScopedPathContext, raw: string): ParsedRecordMutationTarget & { agent: ScopedAgentContext; filename: string; recordUrl: string } {
  const agent = requireAgent(ctx, 'record:///');
  let parsed: ParsedRecordMutationTarget; try { parsed = parseRecordMutationUrl(raw); } catch (error) { throw ctx.fail(toolFacingErrorMessage(error)); }
  const filename = parsed.name; const cardId = parsed.cardId;
  if(!ctx.records)throw ctx.fail('Record writes require an injected persistence reader.');
  recordDefinitionOrNotFound(ctx, cardId, filename);
  return { ...parsed, agent, filename, recordUrl: parsed.currentUrl };
}

export function resolveRecordReadTarget(ctx: ResolveScopedPathContext, raw: string): RecordProjection {
  if (!ctx.records) throw ctx.fail('Record reads require an injected persistence reader.');
  requireAgent(ctx, 'record:///');
  const match=/^record:\/\/\/([^/?#]+)\?card=([^&#]+)(?:&v=([1-9][0-9]*))?$/.exec(raw);if(!match)throw ctx.fail(`Invalid record URL '${raw}'.`);
  let filename:string;let decodedCardId:string;try{filename=decodeURIComponent(match[1]!);decodedCardId=decodeURIComponent(match[2]!);}catch{throw ctx.fail(`Invalid record URL '${raw}'.`);}
  if(/%[0-9a-f]{2}/i.test(filename)||/%[0-9a-f]{2}/i.test(decodedCardId))throw ctx.fail(`Invalid record URL '${raw}'.`);
  const cardId = cardIdSchema.parse(validRecordSegment(decodedCardId, 'card id', raw, ctx.fail));
  recordDefinitionOrNotFound(ctx, cardId, filename);
  const version = match[3];
  if (version === undefined) return readRecordOrNotFound(ctx, () => ctx.records!.current(cardId, filename));
  const numeric = Number(version); if (!Number.isSafeInteger(numeric)) throw ctx.fail(`Invalid record version '${version}'.`);
  return readRecordOrNotFound(ctx, () => ctx.records!.historical(cardId, filename, numeric));
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
  const contained = resolveContainedProjectPath(workRoot, rel);
  if (!contained.safe || !contained.relativePath || contained.relativePath === '.' || contained.relativePath.startsWith('../')) throw new Error(`Path '${absolutePath}' is not under the work root.`);
  return buildScopedPathUrl('work', contained.relativePath.split('/'));
}

export function parseScopedPathScheme(raw: string): ScopedPathScheme | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!match) return null;
  const scheme = match[1] as ScopedPathScheme;
  if (!(scheme in scopedPathResolvers)) throw new Error(`Unsupported scoped URL scheme '${match[1]}'.`);
  if (!raw.startsWith(`${scheme}:///`)) throw new Error(`Invalid ${scheme} URL '${raw}' (expected ${scheme}:///).`);
  return scheme;
}
