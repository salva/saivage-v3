import { join, relative, resolve } from 'node:path';

import type { AgentRole } from '../schemas/index.js';
import { concreteRecordSlot, exposedRecordSlotDefinitionForFilename, latestClosedRecordSlot, openRecordSlot, readRecordSlotIndex, RECORD_OUTPUTS_RELATIVE_DIR, recordSlotDir, type OpenRecordSlot } from '../runtime/records/record-slots.js';
import { resolveContainedProjectPath } from './file-access-security.js';
import { buildScopedPathUrl, parseScopedPathUrl, type ParsedScopedPathUrl } from './scoped-path-url.js';

export type ScopedPathMode = 'read' | 'write' | 'search';
export type ScopedPathErrorFactory = (message: string) => Error;
export type ScopedAgentContext = { cardId?: string; agentRole?: AgentRole };
export type ResolvedScopedPath = { kind: 'project' | 'tmp' | 'system' | 'work'; absolutePath: string; relativePath: string; workRoot?: string } | ({ kind: 'record' } & OpenRecordSlot);

export interface ResolveScopedPathContext {
  projectRoot: string;
  agent?: ScopedAgentContext;
  fail: ScopedPathErrorFactory;
}

export function validRecordSegment(value: string, label: string, raw: string, fail: ScopedPathErrorFactory): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.toLowerCase().includes('..')) throw fail(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}

function requireAgent(ctx: ResolveScopedPathContext, scheme: string): ScopedAgentContext {
  if (!ctx.agent?.agentRole) throw ctx.fail(`${scheme} paths require an active agent role.`);
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

function assertOnlyRecordQuery(raw: string, parsed: ParsedScopedPathUrl, fail: ScopedPathErrorFactory): void {
  if (!parsed.query) return;
  for (const key of parsed.query.keys()) if (key !== 'card' && key !== 'v') throw fail(`Invalid record URL '${raw}' query parameter '${key}'.`);
  if ((parsed.query.getAll('card')).length > 1 || (parsed.query.getAll('v')).length > 1) throw fail(`Invalid record URL '${raw}' duplicate query parameter.`);
}

export function assertRecordWrite(role: AgentRole | undefined, currentCardId: string | undefined, cardId: string, filename: string, version: string, fail: ScopedPathErrorFactory): void {
  if (!currentCardId) throw fail('Record writes require an active card context.');
  if (cardId !== currentCardId) throw fail('Agents may write records only for their current card.');
  const definition = exposedRecordSlotDefinitionForFilename(filename);
  if (!role || !definition.writers.includes(role)) throw fail(`${role} cannot write record slot '${definition.slot}'.`);
  if (version !== 'next') throw fail('Record writes must use v=next.');
}

export function resolveRecordWriteTarget(ctx: ResolveScopedPathContext, raw: string): { agent: ScopedAgentContext; filename: string; cardId: string; version: string; recordUrl: string } {
  const agent = requireAgent(ctx, 'record:///');
  const parsed = parseScopedPathUrl(raw, 'record');
  if (parsed.hadFragment) throw ctx.fail(`record URL '${raw}' must not include a fragment.`);
  assertOnlyRecordQuery(raw, parsed, ctx.fail);
  if (parsed.segments.length !== 1) throw ctx.fail(`Invalid record URL '${raw}'.`);
  const filename = parsed.segments[0]!;
  exposedRecordSlotDefinitionForFilename(filename);
  const cardId = validRecordSegment(parsed.query?.get('card') ?? agent.cardId ?? '', 'card id', raw, ctx.fail);
  const version = parsed.query?.get('v') ?? 'next';
  return { agent, filename, cardId, version, recordUrl: `${buildScopedPathUrl('record', [filename])}?card=${encodeURIComponent(cardId)}&v=${encodeURIComponent(version)}` };
}

function resolveRecordReadTarget(ctx: ResolveScopedPathContext, raw: string): OpenRecordSlot {
  const agent = requireAgent(ctx, 'record:///');
  const parsed = parseScopedPathUrl(raw, 'record');
  if (parsed.hadFragment) throw ctx.fail(`record URL '${raw}' must not include a fragment.`);
  assertOnlyRecordQuery(raw, parsed, ctx.fail);
  if (parsed.segments.length !== 1) throw ctx.fail(`Invalid record URL '${raw}'.`);
  const filename = parsed.segments[0]!;
  exposedRecordSlotDefinitionForFilename(filename);
  const cardId = validRecordSegment(parsed.query?.get('card') ?? agent.cardId ?? '', 'card id', raw, ctx.fail);
  const version = parsed.query?.get('v') ?? 'latest';
  if (version === 'next') {
    const open = openRecordSlot(ctx.projectRoot, { cardId, filename });
    if (!agent.cardId || cardId !== agent.cardId || !exposedRecordSlotDefinitionForFilename(filename).writers.includes(agent.agentRole!)) throw ctx.fail('Only the owning agent may read its current open record slot.');
    return open;
  }
  if (version === 'latest') return latestClosedRecordSlot(ctx.projectRoot, { cardId, filename });
  const numeric = Number(version);
  if (!Number.isInteger(numeric) || numeric < 1) throw ctx.fail(`Invalid record version '${version}'.`);
  const record = concreteRecordSlot(ctx.projectRoot, { cardId, filename, version: numeric });
  const entry = readRecordSlotIndex(ctx.projectRoot, cardId, record.slot).versions[String(numeric)];
  if (entry.status !== 'closed' && !(entry.status === 'open' && cardId === agent.cardId && exposedRecordSlotDefinitionForFilename(filename).writers.includes(agent.agentRole!))) throw ctx.fail('Only closed records are readable outside the owning open slot.');
  return record;
}

export function resolveRecordSearchTarget(ctx: ResolveScopedPathContext, raw: string): { absolutePath: string; relativePath: string } {
  const parsed = parseScopedPathUrl(raw, 'record');
  if (parsed.query !== null || parsed.hadFragment) throw ctx.fail(`Invalid record search URL '${raw}'.`);
  if (parsed.segments.length < 1 || parsed.segments.length > 2) throw ctx.fail(`Invalid record search URL '${raw}'.`);
  const cardId = validRecordSegment(parsed.segments[0]!, 'card id', raw, ctx.fail);
  const slotOrFilename = parsed.segments[1];
  const absolutePath = slotOrFilename ? recordSlotDir(ctx.projectRoot, cardId, exposedRecordSlotDefinitionForFilename(slotOrFilename.includes('.') ? slotOrFilename : `${slotOrFilename}.md`).slot) : join(ctx.projectRoot, RECORD_OUTPUTS_RELATIVE_DIR, cardId);
  const relativePath = relative(ctx.projectRoot, absolutePath).replace(/\\/g, '/');
  const contained = resolveContainedProjectPath(ctx.projectRoot, relativePath);
  if (!contained.safe || contained.relativePath !== relativePath || !relativePath.startsWith(`${RECORD_OUTPUTS_RELATIVE_DIR}/${cardId}`)) throw ctx.fail(`Invalid record search URL '${raw}'.`);
  return { absolutePath, relativePath };
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
    for (const segment of parsed.segments) if (segment.toLowerCase().includes('..')) throw ctx.fail(`Invalid system URL '${raw}'.`);
    return { kind: 'system', absolutePath: resolve(`/${parsed.segments.join('/')}`), relativePath: buildScopedPathUrl('system', parsed.segments) };
  },
  tmp(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    const agent = requireAgent(ctx, 'tmp:///');
    const parsed = parseScopedPathUrl(raw, 'tmp');
    rejectQueryAndFragment(raw, 'tmp', parsed, ctx.fail);
    if (parsed.segments.length < 2) throw ctx.fail(`Invalid tmp URL '${raw}'.`);
    const [cardId, ...rest] = parsed.segments;
    if (mode === 'write' && agent.agentRole !== 'analyst' && cardId !== agent.cardId) throw ctx.fail('Agents may write tmp files only for their current card.');
    return { kind: 'tmp', ...resolveContained(ctx, `.saivage-work/cards/${cardId}/tmp/${rest.join('/')}`, 'tmp path') };
  },
  record(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') {
      const target = resolveRecordWriteTarget(ctx, raw);
      assertRecordWrite(target.agent.agentRole, target.agent.cardId, target.cardId, target.filename, target.version, ctx.fail);
      return { kind: 'record', ...openRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: target.filename }) };
    }
    return { kind: 'record', ...resolveRecordReadTarget(ctx, raw) };
  },
  work(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') throw ctx.fail('work:/// paths are read-only.');
    const parsed = parseScopedPathUrl(raw, 'work');
    rejectQueryAndFragment(raw, 'work', parsed, ctx.fail);
    const workRoot = join(ctx.projectRoot, '.saivage-work');
    return { kind: 'work', ...resolveContained(ctx, `.saivage-work/${parsed.segments.join('/')}`, 'work path'), workRoot };
  },
} as const;

export type ScopedPathScheme = keyof typeof scopedPathResolvers;

export function parseScopedPathScheme(raw: string): ScopedPathScheme | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!match) return null;
  const scheme = match[1] as ScopedPathScheme;
  if (!(scheme in scopedPathResolvers)) throw new Error(`Unsupported scoped URL scheme '${match[1]}'.`);
  if (!raw.startsWith(`${scheme}:///`)) throw new Error(`Invalid ${scheme} URL '${raw}' (expected ${scheme}:///).`);
  return scheme;
}
