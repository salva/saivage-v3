import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { globToRegExp, normalizeRel } from './glob-matcher.js';
import {
  parseCardworkUrl,
  parseScopedPathUrl,
  PublicationOutcomeUnknownError,
  type FirstGlobalProtection,
  type WorkGcProtectionSource,
  type WorkGcResult,
  type WorkGcProgressPort,
} from '../contracts/index.js';
import { cardIdSchema } from '../schemas/index.js';
import {
  cardPublicWorkRoot,
  cardReposWorkRoot,
  inspectWorkGcCanonicalState,
  saivageWorkRoot,
  type WorkGcReference,
} from '../persistence/index.js';

interface Candidate {
  readonly path: string;
  readonly owner: string | null;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

type Span = readonly [start: number, end: number];

interface SubtreeSpans {
  readonly candidates: Span;
  readonly entries: Span;
}

/** Call-local observations, never a saved deletion plan or write authority. */
interface WorkGcInventory {
  readonly projectRoot: string;
  readonly candidates: readonly Candidate[];
  readonly entries: readonly string[];
  readonly subtrees: ReadonlyMap<string, SubtreeSpans>;
  readonly observed_logical_bytes: number;
  readonly opaque_entries: number;
}

interface WorkGcOptions {
  readonly mode: 'dry_run' | 'delete';
  readonly before?: number;
  readonly targetBytes?: number;
  readonly minFileBytes?: number;
}

export interface WorkGcCollectionContext {
  readonly progress?: WorkGcProgressPort;
  readonly selectedDryRunPaths?: string[];
  readonly workflows: Parameters<typeof inspectWorkGcCanonicalState>[1];
  /** Fresh, exact operational configuration selected by the running composition. No reload. */
  readonly operationalInputs: unknown;
  readonly operationalPaths?: readonly string[];
  readonly operationalDependencies?: readonly string[];
  readonly protection: { readonly retainAll: boolean; readonly capturePaths: readonly string[] };
  /** Checks cancellation and the same Supervisor collecting hold, including after each yield. */
  readonly assertCollecting: () => void;
  readonly fatal: (error: PublicationOutcomeUnknownError) => never;
}

/** Ordinary interruption after marking may follow known deletions; never lose that attribution. */
export class WorkGcInterruptedError extends Error {
  constructor(
    readonly result: WorkGcResult,
    cause: unknown,
  ) {
    super('Work GC stopped before completing selection.', { cause });
    this.name = 'WorkGcInterruptedError';
  }
}

export class WorkGcReferenceScopeError extends Error {
  constructor(cause?: unknown) {
    super('Required work GC reference scope is unresolved.', { cause });
    this.name = 'WorkGcReferenceScopeError';
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function statOrMissing(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function* coalescedSpans(spans: Span[]): Iterable<Span> {
  spans.sort(([a], [b]) => a - b);
  let start = 0;
  let end = 0;
  for (const [nextStart, nextEnd] of spans) {
    if (nextStart === nextEnd) continue;
    if (nextStart > end) {
      if (start < end) yield [start, end];
      start = nextStart;
    }
    end = Math.max(end, nextEnd);
  }
  if (start < end) yield [start, end];
}

// Reserved publication names are discarded before ANY metadata/content access or accounting.
function reserved(name: string): boolean {
  return name.endsWith('.saivage-tmp');
}

/** Incremental directory reads, synchronous I/O with a real event-loop yield per entry. */
async function* names(
  path: string,
  check: () => void,
  allowMissing = false,
): AsyncGenerator<string> {
  let dir;
  try {
    dir = opendirSync(path);
  } catch (error) {
    if (allowMissing && missing(error)) return;
    throw error;
  }
  try {
    for (;;) {
      check();
      const entry = dir.readSync();
      if (!entry) return;
      await setImmediate();
      check();
      if (!reserved(entry.name)) yield entry.name;
    }
  } finally {
    dir.closeSync();
  }
}

/** Phase 1 deliberately neither consumes canonical state nor acquires a maintenance hold. */
export async function inventoryWorkGarbage(
  projectRoot: string,
  signal: AbortSignal,
  progress?: WorkGcProgressPort,
): Promise<WorkGcInventory> {
  progress?.phase('inventory', { observed_count: 0, observed_logical_bytes: 0, opaque_entries: 0 });
  projectRoot = resolve(projectRoot);
  const root = saivageWorkRoot(projectRoot);
  const candidates: Candidate[] = [];
  const entries: string[] = [];
  const subtrees = new Map<string, SubtreeSpans>();
  let opaque = 0;
  let bytes = 0;
  const observe = () =>
    progress?.update({
      observed_count: candidates.length,
      observed_logical_bytes: bytes,
      opaque_entries: opaque,
    });
  const check = () => {
    signal.throwIfAborted();
    observe();
  };
  check();
  const parentStat = statOrMissing(dirname(root));
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink()))
    throw new Error('Work GC requires an ordinary .saivage directory.');
  const rootStat = statOrMissing(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()))
    throw new Error('Work GC requires an ordinary, non-symlink work root.');
  if (rootStat && rootStat.dev !== parentStat!.dev)
    throw new Error('Work GC refuses an ambiguous work-root filesystem boundary.');
  function ancestorsAreOrdinary(parts: readonly string[]): boolean {
    const parent = statOrMissing(dirname(root));
    if (!parent?.isDirectory() || parent.isSymbolicLink()) return false;
    let path = root;
    for (const part of ['', ...parts.slice(0, -1)]) {
      path = join(path, part);
      const stat = statOrMissing(path);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat!.dev) return false;
    }
    return true;
  }
  async function visit(path: string, parts: string[], owner: string | null): Promise<void> {
    check();
    // The preceding directory iterator yielded. Do not follow a replaced ancestor now.
    if (!ancestorsAreOrdinary(parts)) {
      opaque++;
      return;
    }
    const stat = statOrMissing(path);
    if (!stat) return;
    if (stat.isSymbolicLink() || stat.dev !== rootStat!.dev) {
      opaque++;
      return;
    }
    const depth = parts.length;
    // Names outside these explicit namespaces stay opaque, without descending into them.
    let allowed = false;
    if (parts[0] === 'cards') {
      allowed = depth === 1 || (depth >= 2 && cardIdSchema.safeParse(parts[1]).success);
      if (depth === 2) owner = parts[1]!;
      if (depth >= 3) allowed &&= /^[a-z][a-z0-9-]*$/u.test(parts[2]!);
      if (parts[2] === 'processes' && depth >= 5)
        allowed &&= depth === 5 && (parts[4] === 'stdout.log' || parts[4] === 'stderr.log');
    } else if (parts[0] === 'processes') {
      allowed =
        depth <= 2 || (depth === 3 && (parts[2] === 'stdout.log' || parts[2] === 'stderr.log'));
    } else if (parts[0] === 'tmp') {
      allowed = depth === 1 || parts[1] === 'stash';
    }
    if (!allowed) {
      opaque++;
      return;
    }
    if (stat.isDirectory()) {
      const candidateStart = candidates.length;
      const entryStart = entries.length;
      entries.push(path);
      for await (const name of names(path, check, true))
        await visit(join(path, name), [...parts, name], owner);
      const prior = subtrees.get(path);
      subtrees.set(path, {
        candidates: [prior?.candidates[0] ?? candidateStart, candidates.length],
        entries: [prior?.entries[0] ?? entryStart, entries.length],
      });
    } else if (stat.isFile()) {
      const isLeaf =
        parts[0] === 'cards' ? depth >= 4 : parts[0] === 'processes' ? depth === 3 : depth >= 3;
      if (!isLeaf) {
        opaque++;
        return;
      }
      candidates.push({
        path: relative(root, path),
        owner,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
      entries.push(path);
      bytes += stat.size;
    } else opaque++;
  }
  if (rootStat)
    for await (const name of names(root, check, true)) await visit(join(root, name), [name], null);
  observe();
  return {
    projectRoot,
    candidates,
    entries,
    subtrees,
    observed_logical_bytes: bytes,
    opaque_entries: opaque,
  };
}

type ReferenceOrigin = 'content' | 'operational';

// Allow recognition of a malformed explicit value without normalizing it for the codec.
const cardworkScheme = /^\s*cardwork:/iu;
const scopedScheme = /^(project|system|work|tmp):/u;
const anyUrl = /^[a-z][a-z0-9+.-]*:\/\//iu;
const substitution = /\$\{|\$\(/u;
const pathKey = /(?:path|url|cwd|directory|root|file|dependencies)$/iu;
const operationalName = /^(?:[\w.-]+)?\.(?:txt|md|jsonl?|log|png|jpg|csv|sh|js|ts|yaml|yml)$/u;

function scopeValue(value: unknown): string | undefined {
  while (value !== null && typeof value === 'object' && 'literal' in value) value = value.literal;
  return typeof value === 'string' ? value : undefined;
}

/** Outer-link punctuation can be part of an exact query value (notably a terminal period). */
function carriesCardworkQuery(span: string): boolean {
  if (
    !span.includes('?') ||
    !/^[a-z][a-z0-9+.-]*:\/\//iu.test(span) ||
    /^(?:project|system|work|tmp):/u.test(span)
  )
    return false;
  const url = URL.parse(span);
  if (url === null) return false;
  for (const value of url.searchParams.values()) if (cardworkScheme.test(value)) return true;
  return false;
}

/** Content identifies concrete artifacts, not administrative containers. Never reads contents. */
class WorkReferences {
  readonly paths = new Set<string>();
  private readonly resolvedReferences = new Set<string>();
  private readonly lexicalReferences = new Set<string>();
  private readonly scopeReferences = new Map<string, string[]>();
  private readonly textReferences = new Map<string, boolean>();
  #firstGlobalProtection: FirstGlobalProtection | null = null;
  get firstGlobalProtection(): FirstGlobalProtection | null {
    return this.#firstGlobalProtection;
  }
  protectAll(
    reason: FirstGlobalProtection['reason'],
    source: FirstGlobalProtection['source'],
  ): void {
    if (this.#firstGlobalProtection !== null) return;
    this.#firstGlobalProtection = Object.freeze({ reason, source });
    this.progress?.update({ first_global_protection: this.#firstGlobalProtection });
  }
  readonly root: string;
  private visited = 0;
  constructor(
    private readonly inventory: WorkGcInventory,
    readonly before: number | undefined,
    readonly check: () => void,
    readonly progress?: WorkGcProgressPort,
  ) {
    this.root = saivageWorkRoot(inventory.projectRoot);
  }

  private get projectRoot(): string {
    return this.inventory.projectRoot;
  }

  private async visit(): Promise<void> {
    this.check();
    if (++this.visited % 256 === 0) {
      this.progress?.referenceVisits?.(this.visited);
      await setImmediate();
      this.check();
    }
  }

  private concreteContentPath(path: string): boolean {
    if (!within(this.root, path)) return false;
    const parts = relative(this.root, path).split(sep);
    if (parts[0] === '') return false;
    if (parts[0] === 'cards') {
      if (parts.length === 1) return false;
      if (cardIdSchema.safeParse(parts[1]).success)
        return (
          parts.length > 2 &&
          !(parts.length === 3 && (parts[2] === 'tmp' || parts[2] === 'processes'))
        );
    }
    if (parts[0] === 'processes' && parts.length === 1) return false;
    if (parts[0] === 'tmp' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'stash')))
      return false;
    return true;
  }

  private mark(path: string, origin: ReferenceOrigin, source: WorkGcProtectionSource): void {
    if (origin === 'content') {
      if (this.concreteContentPath(path)) this.paths.add(path);
    } else {
      if (within(path, this.root))
        this.protectAll('operational_root', source as FirstGlobalProtection['source']);
      if (within(this.root, path)) this.paths.add(path);
    }
  }

  async operationalPath(path: string, source: WorkGcProtectionSource): Promise<void> {
    if (this.firstGlobalProtection) return;
    await this.visit();
    this.path(path, 'operational', source, true);
  }

  private path(
    path: string,
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    required: boolean,
  ): void {
    if (this.firstGlobalProtection) return;
    path = resolve(path);
    const key = JSON.stringify([origin, source, required, path]);
    if (this.resolvedReferences.has(key)) return;
    this.resolvedReferences.add(key);
    this.mark(path, origin, source);
    if (this.firstGlobalProtection) return;
    const actual = this.resolvePath(path, required);
    if (actual !== null) this.mark(actual, origin, source);
  }

  private unresolved(required: boolean, cause?: unknown): null {
    if (required) throw new WorkGcReferenceScopeError(cause);
    return null;
  }

  private resolvePath(path: string, required: boolean): string | null {
    // Resolve BEFORE lexical exclusion. Resolve missing suffixes against their existing ancestor,
    // so a missing alias target is still a mark rather than permission to delete its siblings.
    let existing = path;
    const suffix: string[] = [];
    for (;;) {
      let actual: string;
      try {
        try {
          actual = realpathSync(existing);
        } catch (error) {
          if (!missing(error)) throw error;
          const stat = statOrMissing(existing);
          if (stat?.isSymbolicLink()) return this.unresolved(required, error);
          const parent = dirname(existing);
          if (parent === existing) return this.unresolved(required, error);
          suffix.unshift(relative(parent, existing));
          existing = parent;
          continue;
        }
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException | null)?.code !== 'string') throw error;
        return this.unresolved(required, error);
      }
      actual = resolve(actual, ...suffix);
      return actual;
    }
  }

  private scopedPath(scheme: string, segments: readonly string[]): string {
    if (segments.some((part) => part.includes('\0'))) throw new Error('Invalid scope component.');
    if (scheme === 'tmp') {
      const [card, ...rest] = segments;
      return join(this.root, 'cards', cardIdSchema.parse(card), 'tmp', ...rest);
    }
    return join(
      scheme === 'system' ? '/' : scheme === 'work' ? this.root : this.projectRoot,
      ...segments,
    );
  }

  private locatorPath(value: string, required: boolean, advisoryScope = false): string | null {
    try {
      if (cardworkScheme.test(value)) {
        const { area, cardId, pathSegments } = parseCardworkUrl(value);
        const root = area === 'public' ? cardPublicWorkRoot : cardReposWorkRoot;
        return join(root(this.projectRoot, cardId), ...pathSegments);
      }
      const scheme = scopedScheme.exec(value)?.[1];
      if (scheme !== undefined) {
        // Advisory directory syntax permits a single terminal separator, not a second codec attempt.
        const raw =
          advisoryScope && value.endsWith('/') && value.length > scheme.length + 4
            ? value.slice(0, -1)
            : value;
        const parsed = parseScopedPathUrl(raw, scheme);
        if (parsed.query !== null || parsed.hadFragment) return this.unresolved(required);
        return this.scopedPath(scheme, parsed.segments);
      }
      if (/^file:\/\//u.test(value) && !/[?#\0\r\n]/u.test(value)) {
        const path = fileURLToPath(value);
        if (!path.includes('\0')) return path;
      }
    } catch {
      return this.unresolved(required);
    }
    return this.unresolved(required);
  }

  private nativePaths(value: string, bases: readonly string[]): string[] {
    if (!value || value.includes('\0')) return [];
    return isAbsolute(value) ? [value] : bases.map((base) => resolve(base, value));
  }

  private literalPaths(
    value: string,
    bases: readonly string[],
    required: boolean,
    advisoryScope = false,
  ): string[] {
    if (cardworkScheme.test(value) || scopedScheme.test(value) || value.startsWith('file:')) {
      const path = this.locatorPath(value, required, advisoryScope);
      return path === null ? [] : [path];
    }
    return anyUrl.test(value) ? [] : this.nativePaths(value, bases);
  }

  private scopes(paths: readonly string[], required: boolean): string[] {
    if (this.firstGlobalProtection) return [];
    const key = JSON.stringify([required, paths]);
    const previous = this.scopeReferences.get(key);
    if (previous !== undefined) return previous;
    const result = new Set<string>();
    for (const path of paths) {
      const actual = this.resolvePath(path, required);
      if (actual !== null) {
        result.add(path);
        result.add(actual);
      }
    }
    const bounded = [...result];
    this.scopeReferences.set(key, bounded);
    return bounded;
  }

  private suggestedScopes(value: string, bases: readonly string[], required: boolean): string[] {
    if (!cardworkScheme.test(value) && substitution.test(value)) {
      this.unresolved(required);
      return [];
    }
    return this.scopes(this.literalPaths(value, bases, required, true), required);
  }

  private globSpans(scopes: readonly string[]): { full: boolean; candidates: Span[]; entries: Span[] } {
    const candidates: Span[] = [];
    const entries: Span[] = [];
    for (const scope of scopes) {
      // Inventory uses lexical paths, even when the project root is alias-spelled.
      const inner = within(this.root, scope);
      // A noncanonical spelling can match an equal native path outside directory bounds.
      if (inner ? scope === this.root || resolve(scope) !== scope : within(scope, this.root)) {
        return {
          full: true,
          candidates: [[0, this.inventory.candidates.length]],
          entries: [[0, this.inventory.entries.length]],
        };
      }
      if (!inner) continue;
      const subtree = this.inventory.subtrees.get(scope);
      if (subtree === undefined) continue;
      candidates.push(subtree.candidates);
      entries.push(subtree.entries);
    }
    return { full: false, candidates, entries };
  }

  private wideGlobPredicates(scopes: readonly string[], matcher: RegExp) {
    const names = scopes.map((scope) => {
      if (!isAbsolute(scope) || resolve(scope) !== scope)
        return (entry: string) =>
          entry !== scope && within(scope, entry) ? relative(scope, entry) : undefined;
      const prefix = scope.endsWith(sep) ? scope : scope + sep;
      return (entry: string) =>
        entry !== scope && entry.startsWith(prefix) ? entry.slice(prefix.length) : undefined;
    });
    const matches = (name: string) => matcher.test(normalizeRel(name));
    const matchesEntry = (entry: string) =>
      names.some((name) => {
        const rel = name(entry);
        return rel !== undefined && matches(rel);
      });
    const matchesAncestor = (parent: string) =>
      names.some((name) => {
        for (let entry = parent; ; entry = dirname(entry)) {
          const rel = name(entry);
          if (rel === undefined) return false;
          if (matches(rel)) return true;
        }
      });

    // Only the current native parent's facts are reusable; the file's own mark
    // and direct match are independent. No marks are published during the probe.
    let lastParent: string | undefined;
    let protectedParent: boolean | undefined;
    let matchingParent: boolean | undefined;
    const usefulCandidate = (candidate: Candidate) => {
      const path = this.root + sep + candidate.path;
      const parent = dirname(path);
      if (parent !== lastParent) {
        lastParent = parent;
        protectedParent = matchingParent = undefined;
      }
      return (
        !this.paths.has(path) &&
        !(protectedParent ??= this.protects(parent)) &&
        (matchesEntry(path) || (matchingParent ??= matchesAncestor(parent)))
      );
    };
    return { usefulCandidate, matchesEntry };
  }

  private async glob(
    input: string,
    bases: readonly string[],
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    directory?: string,
    nativeMatcher = false,
  ): Promise<void> {
    if (this.firstGlobalProtection) return;
    if (cardworkScheme.test(input)) {
      await this.token(input, bases, origin, source, true);
      return;
    }
    await this.visit();
    if (!input || input.includes('\0')) return;
    const key = JSON.stringify([
      'glob',
      origin,
      source,
      input,
      directory === undefined &&
      (isAbsolute(input) || /^(?:project|system|work|tmp|file):/u.test(input))
        ? []
        : bases,
      directory,
      nativeMatcher,
    ]);
    if (this.lexicalReferences.has(key)) return;
    this.lexicalReferences.add(key);
    const required = origin === 'operational';
    const uri = nativeMatcher
      ? null
      : /^(?:(project|system|work|tmp):\/\/\/|file:\/\/(?:localhost)?\/)/u.exec(input);
    let pattern = input;
    if (uri) {
      try {
        pattern = decodeURIComponent(input.slice(uri[0].length));
      } catch {
        return void this.unresolved(required);
      }
      if (pattern.includes('\0')) return void this.unresolved(required);
    }
    if (!nativeMatcher && substitution.test(pattern)) return void this.unresolved(required);
    if (!nativeMatcher && !uri && anyUrl.test(pattern)) {
      if (scopedScheme.test(pattern) || pattern.startsWith('file:')) this.unresolved(required);
      return;
    }
    let scopes =
      directory === undefined ? [...bases] : this.suggestedScopes(directory, bases, required);
    if (!scopes.length) return;
    const wildcard = pattern.search(/[*?]/u);
    const slash = pattern.lastIndexOf('/', wildcard < 0 ? pattern.length : wildcard);
    if (uri) {
      let fixed: string;
      try {
        const prefix = slash < 0 ? '' : pattern.slice(0, slash);
        if (prefix.includes('#')) return void this.unresolved(required);
        fixed = this.scopedPath(uri[1] ?? 'system', prefix === '' ? [] : prefix.split('/'));
      } catch {
        return void this.unresolved(required);
      }
      scopes = this.scopes([fixed], required);
    } else if (slash >= 0) {
      scopes = this.scopes(this.nativePaths(pattern.slice(0, slash + 1), scopes), required);
    }
    if (slash >= 0) pattern = pattern.slice(slash + 1);
    if (this.firstGlobalProtection) return;
    const matcher = globToRegExp(pattern);
    const matches = (scope: string, entry: string) =>
      entry !== scope && within(scope, entry) && matcher.test(normalizeRel(relative(scope, entry)));
    const spans = this.globSpans(scopes);
    const { usefulCandidate, matchesEntry } = spans.full
      ? this.wideGlobPredicates(scopes, matcher)
      : {
          usefulCandidate: (candidate: Candidate) => {
            const path = join(this.root, candidate.path);
            return (
              !this.protects(path) &&
              scopes.some((scope) => {
                for (let entry = path; entry !== scope && within(scope, entry); entry = dirname(entry))
                  if (matches(scope, entry)) return true;
                return false;
              })
            );
          },
          matchesEntry: (entry: string) => scopes.some((scope) => matches(scope, entry)),
        };
    let useful = false;
    probe: for (const [start, end] of coalescedSpans(spans.candidates)) {
      for (let i = start; i < end; i++) {
        const candidate = this.inventory.candidates[i]!;
        await this.visit();
        if (this.before !== undefined && candidate.mtimeMs >= this.before) continue;
        if (usefulCandidate(candidate)) {
          useful = true;
          break probe;
        }
      }
    }
    if (!useful) return;
    const matched = new Set<string>();
    for (const [start, end] of coalescedSpans(spans.entries)) {
      for (let i = start; i < end; i++) {
        const entry = this.inventory.entries[i]!;
        await this.visit();
        if (matchesEntry(entry)) {
          matched.add(entry);
          if (matched.size === 51) return;
        }
      }
    }
    for (const entry of matched) this.mark(entry, origin, source);
  }

  private async token(
    token: string,
    bases: readonly string[],
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    exact = false,
    cwd?: string,
  ): Promise<void> {
    if (this.firstGlobalProtection) return;
    await this.visit();
    if (!token || token.includes('\0')) return;
    const key = JSON.stringify(['token', origin, source, token, exact, bases, cwd]);
    if (this.lexicalReferences.has(key)) return;
    this.lexicalReferences.add(key);
    const required = origin === 'operational';
    if (cardworkScheme.test(token)) {
      const path = this.locatorPath(token, required);
      if (path !== null) this.path(path, origin, source, required);
      return;
    }
    if (anyUrl.test(token) && !scopedScheme.test(token) && !token.startsWith('file:')) {
      const url = URL.parse(token);
      if (url)
        for (const value of url.searchParams.values())
          if (cardworkScheme.test(value)) await this.token(value, bases, origin, source, true);
          else await this.text(value, bases, origin, source, false, undefined, cwd);
      return;
    }
    if (substitution.test(token)) return void this.unresolved(required);
    if (
      cwd !== undefined &&
      !isAbsolute(token) &&
      !scopedScheme.test(token) &&
      !token.startsWith('file:')
    ) {
      const scopes = this.suggestedScopes(cwd, bases, required);
      if (!scopes.length) return;
      bases = [...new Set([...bases, ...scopes])];
    }
    if (
      !exact &&
      (/[*?]/u.test(token) || /^(?:project|system|work|tmp|file):\/\/.*%(?:2a|3f)/iu.test(token)) &&
      (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(token) ||
        /^(?:project|system|work|tmp|file):/u.test(token))
    ) {
      await this.glob(token, bases, origin, source);
      return;
    }
    for (const path of this.literalPaths(token, bases, required))
      this.path(path, origin, source, required);
  }

  private async text(
    text: string,
    bases: readonly string[],
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    pathValue = false,
    directory?: string,
    cwd?: string,
  ): Promise<boolean> {
    if (this.firstGlobalProtection) return false;
    await this.visit();
    if (pathValue) {
      await this.token(text, bases, origin, source, true, cwd);
      return false;
    }
    const key = JSON.stringify([origin, source, text, bases, directory, cwd]);
    const previous = this.textReferences.get(key);
    if (previous !== undefined) return previous;
    // Only explicitly shell-labelled Markdown fences are excluded; unlabelled text
    // keeps ordinary lexical inference. A closing fence must match its opener.
    let fence: { delimiter: string; length: number; shell: boolean } | null = null;
    text = text
      .split(/(?<=\n)/u)
      .map((line) => {
        const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line);
        if (fence) {
          const masked = fence.shell ? '\n' : line;
          if (
            match &&
            match[1]![0] === fence.delimiter &&
            match[1]!.length >= fence.length &&
            match[2]!.trim() === ''
          )
            fence = null;
          return masked;
        }
        if (!match || (match[1]![0] === '`' && match[2]!.includes('`'))) return line;
        const shell = /^(?:sh|bash|shell|zsh)$/iu.test(match[2]!.trim().split(/\s+/u)[0] ?? '');
        fence = { delimiter: match[1]![0]!, length: match[1]!.length, shell };
        return shell ? '\n' : line;
      })
      .join('');
    // Nested JSON and JSON-escaped strings occur in raw tool arguments and Markdown evidence.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Ordinary prose need not be JSON. */
    }
    if (parsed !== undefined && (typeof parsed !== 'string' || parsed !== text)) {
      const pattern = await this.value(parsed, origin, source, bases, '', directory, cwd);
      this.textReferences.set(key, pattern);
      return pattern;
    }
    const decodeQuote = (quoted: string): string => {
      const inner = quoted.slice(1, -1);
      if (cardworkScheme.test(inner)) return inner;
      if (quoted.startsWith('"')) {
        try {
          return JSON.parse(quoted) as string;
        } catch {
          /* Ordinary prose. */
        }
      }
      return inner;
    };
    const assignment =
      String.raw`\b([a-zA-Z_]\w*)[ \t]*=[ \t]*("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|` +
      '`[^`\\r\\n]*`' +
      ')';
    const group = new RegExp(`${assignment}(?:[ \\t]*,[ \\t]*${assignment})*`, 'gu');
    for (const match of [...text.matchAll(group)]) {
      await this.visit();
      const fields = [...match[0].matchAll(new RegExp(assignment, 'gu'))];
      const directories = fields.filter((field) => field[1] === 'directory');
      const patterns = fields.filter((field) => field[1] === 'pattern');
      if (!directories.length && !patterns.length) continue;
      const scope =
        directories.length === 1 && patterns.length === 1
          ? decodeQuote(directories[0]![2]!)
          : directories.length === 0
            ? directory
            : undefined;
      for (const field of patterns) {
        await this.glob(decodeQuote(field[2]!), bases, origin, source, scope);
        if (this.firstGlobalProtection) return false;
      }
      // Consume only scope/pattern metadata; other assignments remain independent references.
      const consumed = match[0].replace(
        new RegExp(assignment, 'gu'),
        (span: string, name: string) =>
          name === 'directory' || name === 'pattern' ? ' '.repeat(span.length) : span,
      );
      text = text.slice(0, match.index) + consumed + text.slice(match.index! + match[0].length);
    }
    // Keep inferred substitution bodies out of quote and token extraction.
    text = text.replace(/\$\([^)]*\)|\$\{[^}]*\}/gu, (span) =>
      span.replace(/[\s"'`<>]/gu, '\u0001'),
    );
    // Matching delimiters preserve common filenames with spaces. Native single quotes
    // adjacent to words are deliberately not a programming-language literal grammar.
    const tokens = new Set<string>();
    const addQuoted = (quoted: string): void => {
      if (cardworkScheme.test(quoted)) {
        tokens.add(quoted);
        return;
      }
      if (/[\r\n]/u.test(quoted)) return;
      if (
        quoted.includes('/') ||
        (origin === 'operational' && (/^[\w.*?-]+$/u.test(quoted) || operationalName.test(quoted)))
      )
        tokens.add(quoted);
    };
    let cursor = 0;
    const parts: string[] = [];
    for (const match of [
      ...text.matchAll(
        /`([^`\r\n]+)`|"(?:\\.|[^"\\])*"|\[[^\]\r\n]*\]\(<([^>\r\n]*)>\)|\[[^\]\r\n]*\]\(([^\r\n]+?)\)/gu,
      ),
    ]) {
      if (this.firstGlobalProtection) return false;
      await this.visit();
      if (match[0].startsWith('"')) {
        const decoded = decodeQuote(match[0]);
        if (!cardworkScheme.test(decoded) && (/[\r\n]/u.test(decoded) || /^[{[]/u.test(decoded)))
          await this.text(decoded, bases, origin, source, false, directory, cwd);
        else addQuoted(decoded);
      } else {
        const quoted = match[1] ?? match[2] ?? match[3]!;
        const angleDestination =
          match[3] === undefined ? undefined : /^<([^<>]*)>$/u.exec(quoted)?.[1];
        addQuoted(angleDestination ?? quoted);
      }
      const start = match.index!;
      parts.push(text.slice(cursor, start), ' '.repeat(match[0].length));
      cursor = start + match[0].length;
    }
    if (cursor !== 0) {
      parts.push(text.slice(cursor));
      text = parts.join('');
    }
    const wordBefore = (index: number): boolean =>
      /[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, index - 2), index));
    const wordAfter = (index: number): boolean =>
      /^[\p{L}\p{N}_]/u.test(text.slice(index + 1, index + 3));
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "'") continue;
      await this.visit();
      const afterQuote = text.slice(start + 1);
      const explicitUri =
        cardworkScheme.test(afterQuote) ||
        /^(?:project|system|work|tmp|file):\/\//u.test(afterQuote);
      if (!explicitUri && wordBefore(start)) continue;
      for (let end = start + 1; end < text.length && text[end] !== '\n'; end++) {
        if (text[end] !== "'") continue;
        if (!explicitUri && wordBefore(end) && wordAfter(end)) continue;
        if (explicitUri || !wordAfter(end)) {
          addQuoted(text.slice(start + 1, end));
          text = text.slice(0, start) + ' '.repeat(end - start + 1) + text.slice(end + 1);
        }
        start = end;
        break;
      }
    }
    for (const match of text.matchAll(/[^\s<>"'`]+/gu)) {
      await this.visit();
      const span = match[0]
        .replace(/^[([{]+/u, '')
        .replace(/^\w+=(?=\/|\.\.?\/|[a-z]+:\/\/)/iu, '');
      if (
        !span.includes('/') &&
        !cardworkScheme.test(span) &&
        !(origin === 'operational' && (operationalName.test(span) || /[*?]/u.test(span)))
      )
        continue;
      // An unmatched substitution opener in an atom cannot contribute a suffix.
      if (substitution.test(span) && !anyUrl.test(span)) {
        this.unresolved(origin === 'operational');
        continue;
      }
      tokens.add(
        cardworkScheme.test(span)
          ? span.replace(/^(cardwork:.*?)[,;:)\]}]+$/iu, '$1')
          : /[),.;:]$/u.test(span) && /[*?]/u.test(span) && !carriesCardworkQuery(span)
            ? span.replace(/[),.;:]+$/u, '')
            : span,
      );
    }
    for (const token of tokens) {
      if (this.firstGlobalProtection) break;
      await this.token(token, bases, origin, source, false, cwd);
      const stripped =
        cardworkScheme.test(token) || /[*?]/u.test(token)
          ? token
          : token.replace(/[),.;:\]}]+$/u, '');
      if (stripped !== token) await this.token(stripped, bases, origin, source, false, cwd);
    }
    this.textReferences.set(key, false);
    return false;
  }

  async content(
    value: unknown,
    source: WorkGcProtectionSource,
    bases: readonly string[],
  ): Promise<void> {
    await this.value(value, 'content', source, bases);
  }

  async conversation(reference: WorkGcReference, bases: readonly string[]): Promise<void> {
    const source = 'conversation_content';
    if (this.firstGlobalProtection) return;
    if (reference.kind === 'content') {
      await this.content(reference.value, source, bases);
    } else if (reference.kind === 'address') {
      await this.visit();
      const { syntax, value, required = false } = reference;
      const projectBases = [this.projectRoot];
      if (syntax === 'cardwork' && !cardworkScheme.test(value))
        return void this.unresolved(required);
      if (required && (!value || value.includes('\0'))) return void this.unresolved(required);
      const paths =
        syntax === 'native'
          ? this.nativePaths(value, projectBases)
          : syntax === 'display'
            ? [
                ...this.literalPaths(value, projectBases, false),
                ...(anyUrl.test(value) ? this.nativePaths(value, projectBases) : []),
              ]
            : this.literalPaths(value, projectBases, required);
      for (const path of paths) this.path(path, 'content', source, required);
    } else {
      const projectBases = [this.projectRoot];
      const exact = cardworkScheme.test(reference.pattern);
      if (exact) await this.token(reference.pattern, projectBases, 'content', source, true);
      const paths = this.literalPaths(reference.directory, projectBases, false, true);
      for (const path of new Set([...paths, ...this.scopes(paths, false)])) {
        let stat;
        try {
          stat = statOrMissing(path);
        } catch (error) {
          if (typeof (error as NodeJS.ErrnoException | null)?.code !== 'string') throw error;
          continue;
        }
        if (stat?.isFile()) this.mark(path, 'content', source);
      }
      if (!exact)
        await this.glob(
          reference.pattern,
          projectBases,
          'content',
          source,
          reference.directory,
          true,
        );
    }
  }

  async dependencies(
    values: readonly string[],
    cwd: string,
    bases: readonly string[],
    source: WorkGcProtectionSource,
  ): Promise<void> {
    for (const value of values) await this.dependency(value, [...new Set([cwd, ...bases])], source);
  }

  private async dependency(
    value: string,
    bases: readonly string[],
    source: WorkGcProtectionSource,
  ) {
    const assigned = /^(?:--[\w-]+|[a-z_]\w*)=(.+)$/isu.exec(value)?.[1];
    if (assigned && (assigned.includes('/') || /\.[\w-]+$/u.test(assigned)))
      await this.token(assigned, bases, 'operational', source);
    else if (
      value.includes('/') ||
      (!value.startsWith('-') && (/^[\w.*?%-]+$/u.test(value) || /\.[\w-]+$/u.test(value)))
    )
      await this.token(value, bases, 'operational', source);
    await this.text(value, bases, 'operational', source);
  }

  async operational(
    value: unknown,
    source: WorkGcProtectionSource,
    bases: readonly string[] = [this.projectRoot],
  ): Promise<void> {
    await this.value(value, 'operational', source, bases);
  }

  private async value(
    value: unknown,
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    bases: readonly string[] = [this.projectRoot],
    key = '',
    directory?: string,
    cwd?: string,
  ): Promise<boolean> {
    if (this.firstGlobalProtection) return false;
    await this.visit();
    if (typeof value === 'string') {
      if (key === 'pattern') {
        await this.glob(value, bases, origin, source, directory);
        return true;
      }
      if (origin === 'content' && (key === 'cwd' || key === 'directory')) return false;
      // These operational values are literal program/argument dependencies, not syntax.
      if (origin === 'operational' && /^(?:command|args|argv|artifacts)$/u.test(key)) {
        await this.dependency(value, bases, source);
        return false;
      }
      return this.text(
        value,
        bases,
        origin,
        source,
        pathKey.test(key) || (key === 'target' && cardworkScheme.test(value)),
        directory,
        cwd,
      );
    } else if (Array.isArray(value)) {
      let pattern = false;
      for (const child of value) {
        if (this.firstGlobalProtection) break;
        pattern = (await this.value(child, origin, source, bases, key, directory, cwd)) || pattern;
      }
      return pattern;
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const explicitDirectory = scopeValue(object.directory);
      const explicitCwd = scopeValue(object.cwd);
      const localDirectory = explicitDirectory ?? explicitCwd ?? directory;
      const localCwd = explicitCwd ?? cwd;
      let pattern = false;
      for (const [name, child] of Object.entries(object)) {
        if (this.firstGlobalProtection) break;
        if (
          (name === 'directory' && explicitDirectory !== undefined) ||
          (name === 'cwd' && explicitCwd !== undefined)
        )
          continue;
        const meaning =
          name === 'literal'
            ? key
            : name === 'value' && typeof object.name === 'string'
              ? object.name
              : name;
        pattern =
          (await this.value(child, origin, source, bases, meaning, localDirectory, localCwd)) ||
          pattern;
      }
      if (!pattern && origin === 'operational') {
        if (explicitDirectory !== undefined)
          await this.token(explicitDirectory, bases, origin, source, true);
        if (explicitCwd !== undefined) await this.token(explicitCwd, bases, origin, source, true);
      }
      return pattern;
    }
    return false;
  }

  protects(path: string): boolean {
    if (this.#firstGlobalProtection !== null) return true;
    for (;;) {
      if (this.paths.has(path)) return true;
      if (path === this.root) return false;
      path = dirname(path);
    }
  }
}

async function markCanonical(
  projectRoot: string,
  context: WorkGcCollectionContext,
  refs: WorkReferences,
): Promise<Map<string, number | null>> {
  const bases = (cardId: string | null): readonly string[] =>
    cardId === null
      ? [projectRoot]
      : [projectRoot, join(refs.root, 'cards', cardId), join(refs.root, 'cards', cardId, 'tmp')];
  await refs.operational(context.operationalInputs, 'operational_input');
  for (const path of context.operationalPaths ?? [])
    await refs.operationalPath(resolve(projectRoot, path), 'operational_input');
  await refs.dependencies(
    context.operationalDependencies ?? [],
    projectRoot,
    [projectRoot],
    'operational_input',
  );
  if (refs.firstGlobalProtection) return new Map();
  const owners = await inspectWorkGcCanonicalState(
    projectRoot,
    context.workflows,
    context.assertCollecting,
    {
      content: (value, cardId, source) => refs.content(value, source, bases(cardId)),
      operational: (value, cardId, source) => refs.operational(value, source, bases(cardId)),
      conversation: (value, cardId) => refs.conversation(value, bases(cardId)),
      path: (value, source) => refs.operationalPath(value, source),
      dependencies: (values, cwd, cardId, source) =>
        refs.dependencies(values, cwd, bases(cardId), source),
      done: () => refs.firstGlobalProtection !== null,
    },
    context.progress,
  );
  context.assertCollecting();
  await setImmediate();
  context.assertCollecting();
  return owners;
}

function unchanged(root: string, candidate: Candidate): boolean {
  let path = root;
  const parts = candidate.path.split(sep);
  const parent = statOrMissing(dirname(root));
  if (!parent?.isDirectory() || parent.isSymbolicLink() || parent.dev !== candidate.dev)
    return false;
  const rootStat = statOrMissing(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== candidate.dev)
    return false;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const stat = statOrMissing(path);
    if (!stat || stat.isSymbolicLink() || stat.dev !== candidate.dev) return false;
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) return false;
    } else
      return (
        stat.isFile() &&
        stat.ino === candidate.ino &&
        stat.size === candidate.size &&
        stat.mtimeMs === candidate.mtimeMs &&
        stat.ctimeMs === candidate.ctimeMs
      );
  }
  return false;
}

/** Phase 2: caller owns actual parking/settlement and keeps its hold through return or failure. */
export async function collectWorkGarbage(
  inventory: WorkGcInventory,
  options: WorkGcOptions,
  context: WorkGcCollectionContext,
): Promise<WorkGcResult> {
  context.progress?.phase('retention_marking', {
    inspected_cards: 0,
    inspected_records: 0,
    inspected_sessions: 0,
  });
  const check = context.assertCollecting;
  check();
  await setImmediate();
  check();
  const refs = new WorkReferences(inventory, options.before, check, context.progress);
  const needsMarking = inventory.candidates.some(
    (candidate) => options.before === undefined || candidate.mtimeMs < options.before,
  );
  if (context.protection.retainAll) refs.protectAll('process_owner_uncertain', 'process_owner');
  for (const path of !needsMarking || context.protection.retainAll
    ? []
    : context.protection.capturePaths) {
    if (refs.firstGlobalProtection) break;
    await setImmediate();
    check();
    await refs.operationalPath(dirname(path), 'process_capture');
  }
  const owners =
    needsMarking && !refs.firstGlobalProtection
      ? await markCanonical(inventory.projectRoot, context, refs)
      : new Map<string, number | null>();
  await setImmediate();
  check();
  const retained = { protected: 0, recent: 0, stale: 0, opaque: 0, target: 0 };
  const { minFileBytes } = options;
  let belowMinFileBytes = 0;
  let selectedCount = 0;
  let selectedBytes = 0;
  let processed = 0;
  const classified = context.progress
    ? () => {
        processed++;
        context.progress?.update({
          candidates_processed: processed,
          ...(options.mode === 'dry_run'
            ? { would_delete_count: selectedCount, would_delete_logical_bytes: selectedBytes }
            : { deleted_count: selectedCount, deleted_logical_bytes: selectedBytes }),
        });
      }
    : undefined;
  context.progress?.phase('selection', {
    candidates_processed: 0,
    ...(options.mode === 'dry_run'
      ? { would_delete_count: 0, would_delete_logical_bytes: 0 }
      : { deleted_count: 0, deleted_logical_bytes: 0 }),
  });
  const root = saivageWorkRoot(inventory.projectRoot);
  const report = (): WorkGcResult => {
    const remaining = inventory.observed_logical_bytes - selectedBytes;
    return {
      mode: options.mode,
      observed_count: inventory.candidates.length,
      observed_logical_bytes: inventory.observed_logical_bytes,
      opaque_entries: inventory.opaque_entries,
      whole_work_size_known: false,
      first_global_protection: refs.firstGlobalProtection,
      retained: {
        ...retained,
        ...(minFileBytes === undefined ? {} : { below_min_file_bytes: belowMinFileBytes }),
      },
      would_delete_count: options.mode === 'dry_run' ? selectedCount : 0,
      would_delete_logical_bytes: options.mode === 'dry_run' ? selectedBytes : 0,
      deleted_count: options.mode === 'delete' ? selectedCount : 0,
      deleted_logical_bytes: options.mode === 'delete' ? selectedBytes : 0,
      expected_accounted_logical_bytes_remaining: remaining,
      accounted_target_shortfall:
        options.targetBytes === undefined ? null : Math.max(0, remaining - options.targetBytes),
    };
  };
  const ordered = [...inventory.candidates].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const candidate of ordered) {
    await setImmediate();
    const path = join(root, candidate.path);
    let descriptor: number | undefined;
    try {
      check();
      if (refs.firstGlobalProtection) {
        retained.protected++;
        classified?.();
        continue;
      }
      if (!needsMarking && options.before !== undefined && candidate.mtimeMs >= options.before) {
        retained.recent++;
        classified?.();
        continue;
      }
      if (candidate.owner !== null && !owners.has(candidate.owner)) {
        retained.opaque++;
        classified?.();
        continue;
      }
      if (
        refs.protects(path) ||
        (candidate.owner !== null &&
          (owners.get(candidate.owner) === null ||
            candidate.mtimeMs >= owners.get(candidate.owner)!))
      ) {
        retained.protected++;
        classified?.();
        continue;
      }
      if (options.before !== undefined && candidate.mtimeMs >= options.before) {
        retained.recent++;
        classified?.();
        continue;
      }
      if (!unchanged(root, candidate)) {
        retained.stale++;
        classified?.();
        continue;
      }
      if (minFileBytes !== undefined && candidate.size < minFileBytes) {
        belowMinFileBytes++;
        classified?.();
        continue;
      }
      if (
        options.targetBytes !== undefined &&
        inventory.observed_logical_bytes - selectedBytes <= options.targetBytes
      ) {
        retained.target++;
        classified?.();
        continue;
      }
      check();
      if (options.mode === 'delete') descriptor = openSync(dirname(path), 'r');
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) context.fatal(error);
      throw new WorkGcInterruptedError(report(), error);
    }
    if (options.mode === 'delete') {
      // A failure from unlink onward may have committed. No cleanup/readback/report follows it.
      try {
        unlinkSync(path);
        fsyncSync(descriptor!);
        closeSync(descriptor!);
      } catch (error) {
        context.fatal(new PublicationOutcomeUnknownError(error));
      }
    }
    selectedCount++;
    if (options.mode === 'dry_run') context.selectedDryRunPaths?.push(candidate.path);
    selectedBytes += candidate.size;
    classified?.();
  }
  try {
    check();
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) context.fatal(error);
    throw new WorkGcInterruptedError(report(), error);
  }
  return report();
}
