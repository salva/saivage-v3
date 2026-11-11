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
import { PublicationOutcomeUnknownError, type FirstGlobalProtection, type WorkGcProtectionSource, type WorkGcResult, type WorkGcProgressPort } from '../contracts/index.js';
import { cardIdSchema } from '../schemas/index.js';
import { inspectWorkGcCanonicalState, saivageWorkRoot } from '../persistence/index.js';

interface Candidate {
  readonly path: string;
  readonly owner: string | null;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Call-local observations, never a saved deletion plan or write authority. */
interface WorkGcInventory {
  readonly projectRoot: string;
  readonly candidates: readonly Candidate[];
  readonly observed_logical_bytes: number;
  readonly opaque_entries: number;
}

interface WorkGcOptions {
  readonly mode: 'dry_run' | 'delete';
  readonly before?: number;
  readonly targetBytes?: number;
}

export interface WorkGcCollectionContext {
  readonly progress?: WorkGcProgressPort;
  readonly workflows: Parameters<typeof inspectWorkGcCanonicalState>[1];
  /** Fresh, exact operational configuration selected by the running composition. No reload. */
  readonly operationalInputs: unknown;
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
  let opaque = 0;
  let bytes = 0;
  const observe = () => progress?.update({ observed_count: candidates.length, observed_logical_bytes: bytes, opaque_entries: opaque });
  const check = () => { signal.throwIfAborted(); observe(); };
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
      for await (const name of names(path, check, true))
        await visit(join(path, name), [...parts, name], owner);
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
      bytes += stat.size;
    } else opaque++;
  }
  if (rootStat)
    for await (const name of names(root, check, true)) await visit(join(root, name), [name], null);
  observe();
  return { projectRoot, candidates, observed_logical_bytes: bytes, opaque_entries: opaque };
}

type ReferenceOrigin = 'content' | 'operational';

/** Content identifies concrete artifacts, not administrative containers. Never reads contents. */
class WorkReferences {
  readonly paths = new Set<string>();
  #firstGlobalProtection: FirstGlobalProtection | null = null;
  get firstGlobalProtection(): FirstGlobalProtection | null { return this.#firstGlobalProtection; }
  protectAll(reason: FirstGlobalProtection['reason'], source: WorkGcProtectionSource): void {
    if (this.#firstGlobalProtection !== null) return;
    this.#firstGlobalProtection = Object.freeze({ reason, source });
    this.progress?.update({ first_global_protection: this.#firstGlobalProtection });
  }
  readonly root: string;
  private visited = 0;
  constructor(
    readonly projectRoot: string,
    readonly check: () => void,
    readonly progress?: WorkGcProgressPort,
  ) {
    this.root = saivageWorkRoot(projectRoot);
  }

  private async visit(): Promise<void> {
    this.check();
    if (++this.visited % 256 === 0) {
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
      if (within(path, this.root)) this.protectAll('operational_root', source);
      if (within(this.root, path)) this.paths.add(path);
    }
  }

  operationalPath(path: string, source: WorkGcProtectionSource): void {
    this.path(path, 'operational', source);
  }

  private path(path: string, origin: ReferenceOrigin, source: WorkGcProtectionSource): void {
    path = resolve(path);
    this.mark(path, origin, source);
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
          if (stat?.isSymbolicLink()) {
            this.protectAll('reference_scope_unknown', source);
            return;
          }
          const parent = dirname(existing);
          if (parent === existing) {
            this.protectAll('reference_scope_unknown', source);
            return;
          }
          suffix.unshift(relative(parent, existing));
          existing = parent;
          continue;
        }
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException | null)?.code !== 'string') throw error;
        // Either metadata operation can leave reference scope unknown (including long paths).
        this.protectAll('reference_scope_unknown', source);
        return;
      }
      actual = resolve(actual, ...suffix);
      this.mark(actual, origin, source);
      return;
    }
  }

  private async token(
    token: string,
    bases: readonly string[],
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
  ): Promise<void> {
    await this.visit();
    if (!token || token.includes('\0')) return;
    const scheme = /^(project|system|work|tmp):\/\/\/(.*)$/su.exec(token);
    if (scheme) {
      let tail: string;
      try {
        tail = decodeURIComponent(scheme[2]!);
      } catch {
        this.protectAll('reference_scope_unknown', source);
        return;
      }
      // Query/fragment syntax is not valid for these owners. Preserve the plausible path too.
      if (/[?#]/u.test(tail)) {
        await this.token(`${scheme[1]}:///${tail.split(/[?#]/u)[0]}`, bases, origin, source);
        this.protectAll('reference_scope_unknown', source);
        return;
      }
      const base =
        scheme[1] === 'system' ? '/' : scheme[1] === 'work' ? this.root : this.projectRoot;
      if (scheme[1] === 'tmp') {
        const [card, ...rest] = tail.split('/');
        if (!cardIdSchema.safeParse(card).success) {
          this.protectAll('reference_scope_unknown', source);
          return;
        }
        this.path(resolve(this.root, 'cards', card!, 'tmp', ...rest), origin, source);
      } else this.path(resolve(base, tail), origin, source);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token)) {
      // Typed source references can be nested in query components of otherwise non-file links.
      let url: URL | undefined;
      try {
        url = new URL(token);
      } catch {
        if (/work|\.saivage|tmp:/u.test(token)) this.protectAll('reference_scope_unknown', source);
      }
      if (!url) return;
      if (url.protocol === 'file:') {
        let path: string | undefined;
        try {
          path = fileURLToPath(url);
        } catch {
          this.protectAll('reference_scope_unknown', source);
        }
        if (path !== undefined) this.path(path, origin, source);
      } else if (/\.saivage|work:|tmp:/u.test(url.pathname)) this.protectAll('reference_scope_unknown', source);
      for (const value of url.searchParams.values()) await this.text(value, bases, origin, source);
      return;
    }
    if (token.includes('${') || token.includes('$(') || /[*?[]/u.test(token)) {
      const prefix = token.split(/\$|\*|\?|\[/u)[0]!;
      if (prefix.includes('/'))
        await this.token(prefix.endsWith('/') ? prefix : dirname(prefix), bases, origin, source);
      else this.protectAll('reference_scope_unknown', source);
      return;
    }
    if (isAbsolute(token)) this.path(token, origin, source);
    else for (const base of bases) this.path(resolve(base, token), origin, source);
  }

  private async text(
    text: string,
    bases: readonly string[],
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    pathValue = false,
  ): Promise<void> {
    await this.visit();
    if (pathValue) await this.token(text, bases, origin, source);
    // Nested JSON and JSON-escaped strings occur in raw tool arguments and Markdown evidence.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Ordinary prose need not be JSON. */
    }
    if (parsed !== undefined && (typeof parsed !== 'string' || parsed !== text)) {
      await this.value(parsed, origin, source, bases);
      return;
    }
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
      await this.visit();
      let value: unknown;
      try {
        value = JSON.parse(match[0]);
      } catch {
        /* Inspect enclosing text below. */
      }
      if (typeof value === 'string') await this.text(value, bases, origin, source);
    }
    // Matching delimiters preserve common filenames with spaces. Native single quotes
    // adjacent to words are deliberately not a programming-language literal grammar.
    const tokens = new Set<string>();
    const addQuoted = (quoted: string): void => {
      if (/[\r\n]/u.test(quoted)) return;
      if (
        quoted.includes('/') ||
        /^[\w.*?-]+$/u.test(quoted) ||
        /\.(?:txt|md|jsonl?|log|png|jpg|csv|sh|js|ts|yaml|yml)$/u.test(quoted)
      )
        tokens.add(quoted);
    };
    for (const match of text.matchAll(/`([^`\n]+)`|"(?:\\.|[^"\\\n])*"|(?:\]\()([^\n]+?)\)/gu)) {
      await this.visit();
      if (match[0].startsWith('"')) {
        try {
          addQuoted(JSON.parse(match[0]) as string);
        } catch {
          /* Invalid JSON escapes are still ordinary quoted prose. */
          addQuoted(match[0].slice(1, -1));
        }
      } else addQuoted(match[1] ?? match[2]!);
    }
    const wordBefore = (index: number): boolean =>
      /[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, index - 2), index));
    const wordAfter = (index: number): boolean =>
      /^[\p{L}\p{N}_]/u.test(text.slice(index + 1, index + 3));
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "'") continue;
      await this.visit();
      const explicitUri = /^(?:project|system|work|tmp|file):\/\//u.test(text.slice(start + 1));
      if (!explicitUri && wordBefore(start)) continue;
      for (let end = start + 1; end < text.length && text[end] !== '\n'; end++) {
        if (text[end] !== "'") continue;
        if (!explicitUri && wordBefore(end) && wordAfter(end)) continue;
        if (explicitUri || !wordAfter(end)) addQuoted(text.slice(start + 1, end));
        start = end;
        break;
      }
    }
    for (const match of text.matchAll(
      /(?:[a-z]+:\/\/\/?|\/|\.\.?\/|\.saivage\/)[^\s<>"'`]+|[a-zA-Z0-9_.-]+\/[^\s<>"'`]+|\b[a-zA-Z0-9_-]+\.(?:txt|md|jsonl?|log|png|jpg|csv|sh|js|ts|yaml|yml)\b/gu,
    )) {
      await this.visit();
      tokens.add(match[0]);
    }
    for (const token of tokens) {
      await this.token(token, bases, origin, source);
      const stripped = token.replace(/[),.;:\]}]+$/u, '');
      if (stripped !== token) await this.token(stripped, bases, origin, source);
    }
  }

  content(value: unknown, source: WorkGcProtectionSource, bases: readonly string[]): Promise<void> {
    return this.value(value, 'content', source, bases);
  }

  operational(value: unknown, source: WorkGcProtectionSource, bases: readonly string[] = [this.projectRoot]): Promise<void> {
    return this.value(value, 'operational', source, bases);
  }

  private async value(
    value: unknown,
    origin: ReferenceOrigin,
    source: WorkGcProtectionSource,
    bases: readonly string[] = [this.projectRoot],
    key = '',
  ): Promise<void> {
    await this.visit();
    if (typeof value === 'string') {
      await this.text(
        value,
        bases,
        origin,
        source,
        /(?:path|url|cwd|directory|root|file|script|argv|dependencies)$/iu.test(key),
      );
    } else if (Array.isArray(value)) {
      for (const child of value) await this.value(child, origin, source, bases, key);
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const cwd = typeof object.cwd === 'string' ? resolve(this.projectRoot, object.cwd) : null;
      const localBases = cwd ? [...bases, cwd] : bases;
      for (const [name, child] of Object.entries(object)) {
        const meaning =
          name === 'literal'
            ? key
            : name === 'value' && typeof object.name === 'string'
              ? object.name
              : name;
        await this.value(child, origin, source, localBases, meaning);
      }
    }
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
): Promise<Set<string>> {
  const bases = (cardId: string | null): readonly string[] =>
    cardId === null
      ? [projectRoot]
      : [projectRoot, join(refs.root, 'cards', cardId), join(refs.root, 'cards', cardId, 'tmp')];
  const owners = await inspectWorkGcCanonicalState(
    projectRoot,
    context.workflows,
    context.assertCollecting,
    {
      content: (value, cardId, source) => refs.content(value, source, bases(cardId)),
      operational: (value, cardId, source) => refs.operational(value, source, bases(cardId)),
    },
    context.progress,
  );
  context.assertCollecting();
  await setImmediate();
  context.assertCollecting();
  await refs.operational(context.operationalInputs, 'operational_input');
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
  context.progress?.phase('validation_marking', { validated_cards: 0, validated_records: 0, validated_segments: 0 });
  const check = context.assertCollecting;
  check();
  await setImmediate();
  check();
  const refs = new WorkReferences(inventory.projectRoot, check, context.progress);
  if (context.protection.retainAll) refs.protectAll('process_owner_uncertain', 'process_owner');
  for (const path of context.protection.capturePaths) {
    await setImmediate();
    check();
    refs.operationalPath(dirname(path), 'process_capture');
  }
  const owners = await markCanonical(inventory.projectRoot, context, refs);
  await setImmediate();
  check();
  const retained = { protected: 0, recent: 0, stale: 0, opaque: 0, target: 0 };
  let selectedCount = 0;
  let selectedBytes = 0;
  let processed = 0;
  const classified = context.progress ? () => {
    processed++;
    context.progress?.update({
      candidates_processed: processed,
      ...(options.mode === 'dry_run'
        ? { would_delete_count: selectedCount, would_delete_logical_bytes: selectedBytes }
        : { deleted_count: selectedCount, deleted_logical_bytes: selectedBytes }),
    });
  } : undefined;
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
      retained: { ...retained },
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
      if (candidate.owner !== null && !owners.has(candidate.owner)) {
        retained.opaque++;
        classified?.();
        continue;
      }
      if (refs.protects(path)) {
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
