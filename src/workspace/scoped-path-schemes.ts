import { lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { AgentName, RecordDefinition } from '../schemas/index.js';
import type { RecordProjection } from '../persistence/index.js';
import type { CardService } from '../cards/store-api.js';
type CompleteRecordReader = Pick<CardService, 'readRecordCurrent' | 'readRecordVersion'>;
import {
  assertReachedObjectAuthority,
  ToolArgumentValidationError,
  type DirectObjectAuthority,
} from '../tools/tool-api.js';
import {
  isReadBlocked,
  isWriteBlocked,
  looksLikeSecretPath,
  resolveContainedProjectPath,
} from './file-access-security.js';
import { projectDynamicForOutbound } from '../redaction/index.js';
import {
  buildCardworkUrl,
  buildScopedPathUrl,
  encodeCardworkSegment,
  parseCardworkUrl,
  parseScopedPathUrl,
  parseRecordUrl,
  RecordUrlInputError,
  type CardworkAddress,
  type ParsedScopedPathUrl,
  type ParsedRecordUrl,
} from '../contracts/index.js';
import {
  cardPublicWorkRoot,
  cardReposWorkRoot,
  cardTmpRelativePath,
  saivageWorkRelativePath,
  saivageWorkRoot,
} from '../persistence/index.js';

type ScopedPathMode = 'read' | 'write' | 'search';
type ScopedPathErrorFactory = (message: string) => Error;
type ScopedAgentContext = { cardId?: string; agentName?: AgentName };
type ResolvedRecordReadTarget = Readonly<{
  parsed: ParsedRecordUrl;
  definition: RecordDefinition;
  projection: RecordProjection | null;
}>;
type ResolvedScopedPath =
  | {
      kind: 'project' | 'tmp' | 'system' | 'work';
      absolutePath: string;
      relativePath: string;
      workRoot?: string;
    }
  | ({ kind: 'record' } & ResolvedRecordReadTarget);

export interface ResolvedCardworkPath {
  kind: 'cardwork';
  absolutePath: string;
  relativePath: string;
  locator: string;
  isRoot: boolean;
  checkoutChildrenOnly: boolean;
}

export interface ResolveScopedPathContext {
  selection?: { readonly authority: DirectObjectAuthority; readonly tool: string };
  projectRoot: string;
  agent?: ScopedAgentContext;
  fail: ScopedPathErrorFactory;
  records?: CompleteRecordReader;
}

export function validRecordSegment(
  value: string,
  label: string,
  raw: string,
  fail: ScopedPathErrorFactory,
): string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.toLowerCase().includes('..')
  )
    throw fail(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}

function requireAgent(ctx: ResolveScopedPathContext, scheme: string): ScopedAgentContext {
  if (!ctx.agent?.agentName) throw ctx.fail(`${scheme} paths require an active named agent.`);
  return ctx.agent;
}

function rejectQueryAndFragment(
  raw: string,
  scheme: string,
  parsed: ParsedScopedPathUrl,
  fail: ScopedPathErrorFactory,
): void {
  if (parsed.query !== null) throw fail(`${scheme} URL '${raw}' must not include a query string.`);
  if (parsed.hadFragment) throw fail(`${scheme} URL '${raw}' must not include a fragment.`);
}

function resolveContained(
  ctx: ResolveScopedPathContext,
  rel: string,
  label: string,
): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(ctx.projectRoot, rel);
  if (!resolved.safe || !resolved.relativePath)
    throw ctx.fail(resolved.reason ?? `${label} must resolve inside the project root.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

function checkOrdinaryPath(
  ctx: ResolveScopedPathContext,
  absolutePath: string,
  target: 'file' | 'directory' | 'either',
  allowMissingFrom = Infinity,
): void {
  const segments = relative(ctx.projectRoot, absolutePath).split(sep);
  let current = resolve(ctx.projectRoot);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat =
      index >= allowMissingFrom
        ? lstatSync(current, { throwIfNoEntry: false })
        : lstatSync(current);
    if (stat === undefined) return;
    const ordinary =
      index < segments.length - 1 || target === 'directory'
        ? stat.isDirectory()
        : stat.isFile() || (target === 'either' && stat.isDirectory());
    if (!ordinary)
      throw ctx.fail('Scoped workspace paths require ordinary directories and files, not symlinks.');
  }
}

const CARDWORK_UNREPRESENTABLE = 'Cardwork address cannot be represented as an unchanged receipt.';

function unchangedForOutbound(value: string): boolean {
  return projectDynamicForOutbound(value) === value;
}

export function isCardworkComponentVisible(name: string, absolutePath: string): boolean {
  return name !== '.git' && name !== '.saivage' &&
    !isReadBlocked(name) && !isWriteBlocked(name) && !looksLikeSecretPath(absolutePath);
}

function admittedChildLocator(name: string, parentLocator: string): string | null {
  if (!unchangedForOutbound(name)) return null;
  let encoded: string;
  try {
    encoded = encodeCardworkSegment(name);
  } catch {
    return null;
  }
  const locator = `${parentLocator}/${encoded}`;
  return unchangedForOutbound(locator) ? locator : null;
}

export function admitCardworkChild(
  raw: Buffer,
  parentLocator: string,
): { name: string; locator: string } | null {
  const name = raw.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(raw)) return null;
  const locator = admittedChildLocator(name, parentLocator);
  return locator === null ? null : { name, locator };
}

function resolveCardworkPath(
  ctx: ResolveScopedPathContext,
  raw: string,
  mode: ScopedPathMode,
): ResolvedCardworkPath {
  let address: CardworkAddress;
  try {
    address = parseCardworkUrl(raw);
  } catch {
    throw ctx.fail('Invalid cardwork URL.');
  }
  const { cardId, area, pathSegments } = address;
  const agent = requireAgent(ctx, 'cardwork:///');
  if (agent.cardId !== cardId || ctx.selection?.authority.anchorCardId !== cardId)
    throw ctx.fail('Cardwork paths require the owning card binding.');
  assertReachedObjectAuthority(ctx.selection.authority, ctx.selection.tool, { kind: 'workspace' });
  if (!unchangedForOutbound(raw)) throw ctx.fail(CARDWORK_UNREPRESENTABLE);
  let prefix = buildCardworkUrl({ cardId, area, pathSegments: [] });
  for (const name of pathSegments) {
    const child = admittedChildLocator(name, prefix);
    if (!child) throw ctx.fail(CARDWORK_UNREPRESENTABLE);
    prefix = child;
  }
  const writing = mode === 'write';
  const directory = pathSegments.length < (area === 'repos' ? 2 : 1);
  if (writing && directory)
    throw ctx.fail('Cardwork writes require a file below public or an existing repos checkout.');
  const base = (area === 'public' ? cardPublicWorkRoot : cardReposWorkRoot)(ctx.projectRoot, cardId);
  let absolutePath = base;
  for (const name of pathSegments) {
    absolutePath = join(absolutePath, name);
    if (!isCardworkComponentVisible(name, absolutePath))
      throw ctx.fail('Access to this cardwork path is blocked.');
  }
  const relativePath = relative(ctx.projectRoot, absolutePath);
  if (writing) {
    const requiredComponents = area === 'repos'
      ? relative(ctx.projectRoot, base).split(sep).length + 1
      : 0;
    checkOrdinaryPath(ctx, absolutePath, 'file', requiredComponents);
  } else {
    checkOrdinaryPath(ctx, absolutePath, directory ? 'directory' : 'either');
  }
  return {
    kind: 'cardwork',
    absolutePath,
    relativePath,
    locator: raw,
    isRoot: pathSegments.length === 0,
    checkoutChildrenOnly: area === 'repos' && pathSegments.length === 0,
  };
}

export function resolveRecordWriteTarget(
  ctx: ResolveScopedPathContext,
  raw: string,
): ParsedRecordUrl & {
  agent: ScopedAgentContext;
  filename: string;
  recordUrl: string;
  definition: RecordDefinition;
} {
  const agent = requireAgent(ctx, 'record:///');
  let parsed: ParsedRecordUrl;
  try {
    parsed = parseRecordUrl(raw);
  } catch (error) {
    if (!(error instanceof RecordUrlInputError)) throw error;
    throw ctx.fail(error.message);
  }
  if (parsed.version !== null) throw ctx.fail('Historical record URLs cannot be mutated.');
  const filename = parsed.name;
  const cardId = parsed.cardId;
  if (!ctx.records) throw ctx.fail('Record writes require an injected persistence reader.');
  const result = ctx.records.readRecordCurrent(cardId, filename);
  if (result.kind === 'card-not-found') throw ctx.fail('Record not found.');
  return {
    ...parsed,
    agent,
    filename,
    recordUrl: parsed.currentUrl,
    definition: result.value.definition,
  };
}

export function resolveRecordReadTarget(
  ctx: ResolveScopedPathContext,
  raw: string,
): ResolvedRecordReadTarget {
  if (!ctx.records) throw ctx.fail('Record reads require an injected persistence reader.');
  requireAgent(ctx, 'record:///');
  let parsed: ParsedRecordUrl;
  try {
    parsed = parseRecordUrl(raw);
  } catch (error) {
    if (!(error instanceof RecordUrlInputError)) throw error;
    throw ctx.fail(error.message);
  }
  let reached = false;
  const selection = ctx.selection;
  const checkReached = selection
    ? (cardId: string) => {
        reached = true;
        assertReachedObjectAuthority(selection.authority, selection.tool, {
          kind: 'record',
          cardId,
          name: parsed.name,
        });
      }
    : undefined;
  const result =
    parsed.version === null
      ? ctx.records.readRecordCurrent(parsed.cardId, parsed.name, undefined, checkReached)
      : ctx.records.readRecordVersion(
          parsed.cardId,
          parsed.name,
          parsed.version,
          undefined,
          checkReached,
        );
  if (ctx.selection && result.kind === 'card-not-found' && !reached)
    throw new ToolArgumentValidationError(`Card '${parsed.cardId}' not found.`);
  if (result.kind !== 'found') throw ctx.fail('Record not found.');
  return Object.freeze({
    parsed,
    definition: result.value.definition,
    projection: result.value.projection,
  });
}

export const scopedPathResolvers = {
  cardwork: resolveCardworkPath,
  project(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    const parsed = parseScopedPathUrl(raw, 'project');
    rejectQueryAndFragment(raw, 'project', parsed, ctx.fail);
    const relativePath = parsed.segments.join('/');
    return mode === 'write'
      ? { kind: 'project', absolutePath: resolve(ctx.projectRoot, relativePath), relativePath }
      : { kind: 'project', ...resolveContained(ctx, relativePath, 'project path') };
  },
  system(ctx: ResolveScopedPathContext, raw: string): ResolvedScopedPath {
    const parsed = parseScopedPathUrl(raw, 'system');
    rejectQueryAndFragment(raw, 'system', parsed, ctx.fail);
    return {
      kind: 'system',
      absolutePath: resolve(`/${parsed.segments.join('/')}`),
      relativePath: buildScopedPathUrl('system', parsed.segments),
    };
  },
  tmp(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    const agent = requireAgent(ctx, 'tmp:///');
    const parsed = parseScopedPathUrl(raw, 'tmp');
    rejectQueryAndFragment(raw, 'tmp', parsed, ctx.fail);
    if (parsed.segments.length < 2) throw ctx.fail(`Invalid tmp URL '${raw}'.`);
    const [cardId, ...rest] = parsed.segments;
    if (mode === 'write' && cardId !== agent.cardId)
      throw ctx.fail('Card-scoped agents may write tmp files only for their current card.');
    const rel = cardTmpRelativePath(cardId!, ...rest);
    if (mode === 'write')
      checkOrdinaryPath(ctx, resolve(ctx.projectRoot, rel), 'file', 0);
    return {
      kind: 'tmp',
      ...resolveContained(ctx, rel, 'tmp path'),
    };
  },
  record(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') {
      throw ctx.fail(
        'Record writes are logical mutations and cannot resolve to a filesystem path.',
      );
    }
    return { kind: 'record', ...resolveRecordReadTarget(ctx, raw) };
  },
  work(ctx: ResolveScopedPathContext, raw: string, mode: ScopedPathMode): ResolvedScopedPath {
    if (mode === 'write') throw ctx.fail('work:/// paths are read-only.');
    const parsed = parseScopedPathUrl(raw, 'work');
    rejectQueryAndFragment(raw, 'work', parsed, ctx.fail);
    const workRoot = saivageWorkRoot(ctx.projectRoot);
    return {
      kind: 'work',
      ...resolveContained(ctx, saivageWorkRelativePath(...parsed.segments), 'work path'),
      workRoot,
    };
  },
} as const;

export type ScopedPathScheme = keyof typeof scopedPathResolvers;

export function workUrlFromAbsolutePath(projectRoot: string, absolutePath: string): string {
  const workRoot = saivageWorkRoot(projectRoot);
  const rel = relative(workRoot, absolutePath).replace(/\\/g, '/');
  const contained = resolveContainedProjectPath(workRoot, rel === '' ? '.' : rel);
  if (!contained.safe || !contained.relativePath || contained.relativePath.startsWith('../'))
    throw new Error(`Path '${absolutePath}' is not under the work root.`);
  return buildScopedPathUrl(
    'work',
    contained.relativePath === '.' ? [] : contained.relativePath.split('/'),
  );
}

export function parseScopedPathScheme(raw: string): ScopedPathScheme | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!match) return null;
  const scheme = match[1] as ScopedPathScheme;
  if (!(scheme in scopedPathResolvers))
    throw new Error(`Unsupported scoped URL scheme '${match[1]}'.`);
  if (!raw.startsWith(`${scheme}:///`))
    throw new Error(
      scheme === 'cardwork' ? 'Invalid cardwork URL.' : `Invalid ${scheme} URL '${raw}' (expected ${scheme}:///).`,
    );
  return scheme;
}
