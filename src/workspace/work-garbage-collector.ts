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
import { PublicationOutcomeUnknownError, type WorkGcResult } from '../contracts/index.js';
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
): Promise<WorkGcInventory> {
  projectRoot = resolve(projectRoot);
  const root = saivageWorkRoot(projectRoot);
  const check = () => signal.throwIfAborted();
  check();
  const parentStat = statOrMissing(dirname(root));
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink()))
    throw new Error('Work GC requires an ordinary .saivage directory.');
  const rootStat = statOrMissing(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()))
    throw new Error('Work GC requires an ordinary, non-symlink work root.');
  if (rootStat && rootStat.dev !== parentStat!.dev)
    throw new Error('Work GC refuses an ambiguous work-root filesystem boundary.');
  const candidates: Candidate[] = [];
  let opaque = 0;
  let bytes = 0;
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
  return { projectRoot, candidates, observed_logical_bytes: bytes, opaque_entries: opaque };
}

/** Reference interpretation is deliberately conservative; it never reads referenced contents. */
class WorkReferences {
  readonly paths = new Set<string>();
  retainAll = false;
  readonly root: string;
  constructor(readonly projectRoot: string) {
    this.root = saivageWorkRoot(projectRoot);
  }

  path(path: string): void {
    path = resolve(path);
    if (within(path, this.root)) this.retainAll = true;
    if (within(this.root, path)) this.paths.add(path);
    // Resolve BEFORE lexical exclusion. Resolve missing suffixes against their existing ancestor,
    // so a missing alias target is still a mark rather than permission to delete its siblings.
    let existing = path;
    const suffix: string[] = [];
    for (;;) {
      try {
        const actual = resolve(realpathSync(existing), ...suffix);
        if (within(actual, this.root)) this.retainAll = true;
        if (within(this.root, actual)) this.paths.add(actual);
        return;
      } catch (error) {
        if (!missing(error)) {
          // A looping/denied alias cannot establish a safe non-work scope.
          this.retainAll = true;
          return;
        }
        const stat = statOrMissing(existing);
        if (stat?.isSymbolicLink()) {
          this.retainAll = true;
          return;
        }
        const parent = dirname(existing);
        if (parent === existing) {
          this.retainAll = true;
          return;
        }
        suffix.unshift(relative(parent, existing));
        existing = parent;
      }
    }
  }

  token(token: string, bases: readonly string[]): void {
    if (!token || token.includes('\0')) return;
    const scheme = /^(project|system|work|tmp):\/\/\/(.*)$/su.exec(token);
    if (scheme) {
      let tail: string;
      try {
        tail = decodeURIComponent(scheme[2]!);
      } catch {
        this.retainAll = true;
        return;
      }
      // Query/fragment syntax is not valid for these owners. Preserve the plausible path too.
      if (/[?#]/u.test(tail)) {
        this.token(`${scheme[1]}:///${tail.split(/[?#]/u)[0]}`, bases);
        this.retainAll = true;
        return;
      }
      const base =
        scheme[1] === 'system' ? '/' : scheme[1] === 'work' ? this.root : this.projectRoot;
      if (scheme[1] === 'tmp') {
        const [card, ...rest] = tail.split('/');
        if (!cardIdSchema.safeParse(card).success) {
          this.retainAll = true;
          return;
        }
        this.path(resolve(this.root, 'cards', card!, 'tmp', ...rest));
      } else this.path(resolve(base, tail));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token)) {
      // Typed source references can be nested in query components of otherwise non-file links.
      let url: URL | undefined;
      try {
        url = new URL(token);
      } catch {
        if (/work|\.saivage|tmp:/u.test(token)) this.retainAll = true;
      }
      if (!url) return;
      if (url.protocol === 'file:') {
        try {
          this.path(fileURLToPath(url));
        } catch {
          this.retainAll = true;
        }
      } else if (/\.saivage|work:|tmp:/u.test(url.pathname)) this.retainAll = true;
      for (const value of url.searchParams.values()) this.text(value, bases);
      return;
    }
    if (token.includes('${') || token.includes('$(') || /[*?[]/u.test(token)) {
      const prefix = token.split(/\$|\*|\?|\[/u)[0]!;
      if (prefix.includes('/')) this.token(prefix.endsWith('/') ? prefix : dirname(prefix), bases);
      else this.retainAll = true;
      return;
    }
    if (isAbsolute(token)) this.path(token);
    else for (const base of bases) this.path(resolve(base, token));
  }

  text(text: string, bases: readonly string[], pathValue = false): void {
    if (pathValue) this.token(text, bases);
    // Nested JSON and JSON-escaped strings occur in raw tool arguments and Markdown evidence.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Ordinary prose need not be JSON. */
    }
    if (parsed !== undefined && (typeof parsed !== 'string' || parsed !== text)) {
      this.value(parsed, bases);
      return;
    }
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
      let value: unknown;
      try {
        value = JSON.parse(match[0]);
      } catch {
        /* Inspect enclosing text below. */
      }
      if (typeof value === 'string') this.text(value, bases);
    }
    // Quotes/backticks preserve spaces; URI/native tokens retain percent bytes distinctly.
    const tokens = new Set<string>();
    for (const match of text.matchAll(/[`']([^`'\n]+)[`']|"([^"\n]+)"|(?:\]\()([^\n]+?)\)/gu)) {
      const quoted = match[1] ?? match[2] ?? match[3]!;
      // Apostrophes also delimit ordinary prose, not just filenames. Require path syntax
      // or a single basename; do not interpret whole quoted sentences/card links as globs.
      // Exact path-valued fields remain handled above, including names without extensions.
      if (
        quoted.includes('/') ||
        /^[\w.*?-]+$/u.test(quoted) ||
        /\.(?:txt|md|jsonl?|log|png|jpg|csv|sh|js|ts|yaml|yml)$/u.test(quoted)
      )
        tokens.add(quoted);
    }
    for (const match of text.matchAll(
      /(?:[a-z]+:\/\/\/?|\/|\.\.?\/|\.saivage\/)[^\s<>"'`]+|[a-zA-Z0-9_.-]+\/[^\s<>"'`]+|\b[a-zA-Z0-9_-]+\.(?:txt|md|jsonl?|log|png|jpg|csv|sh|js|ts|yaml|yml)\b/gu,
    ))
      tokens.add(match[0]);
    for (const token of tokens) {
      this.token(token, bases);
      const stripped = token.replace(/[),.;:\]}]+$/u, '');
      if (stripped !== token) this.token(stripped, bases);
    }
  }

  value(value: unknown, bases: readonly string[] = [this.projectRoot], key = ''): void {
    if (typeof value === 'string') {
      this.text(
        value,
        bases,
        /(?:path|url|cwd|directory|root|file|script|argv|dependencies)$/iu.test(key),
      );
    } else if (Array.isArray(value)) {
      for (const child of value) this.value(child, bases, key);
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
        this.value(child, localBases, meaning);
      }
    }
  }

  protects(path: string): boolean {
    return this.retainAll || [...this.paths].some((mark) => within(mark, path));
  }
}

async function markCanonical(
  projectRoot: string,
  context: WorkGcCollectionContext,
  refs: WorkReferences,
): Promise<Set<string>> {
  const owners = await inspectWorkGcCanonicalState(
    projectRoot,
    context.workflows,
    context.assertCollecting,
    (value, cardId) =>
      refs.value(
        value,
        cardId === null
          ? [projectRoot]
          : [
              projectRoot,
              join(refs.root, 'cards', cardId),
              join(refs.root, 'cards', cardId, 'tmp'),
            ],
      ),
  );
  refs.value(context.operationalInputs);
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
  const check = context.assertCollecting;
  check();
  const refs = new WorkReferences(inventory.projectRoot);
  refs.retainAll = context.protection.retainAll;
  for (const path of context.protection.capturePaths) refs.path(dirname(path));
  const owners = await markCanonical(inventory.projectRoot, context, refs);
  const retained = { protected: 0, recent: 0, stale: 0, opaque: 0, target: 0 };
  let selectedCount = 0;
  let selectedBytes = 0;
  const root = saivageWorkRoot(inventory.projectRoot);
  const report = (): WorkGcResult => {
    const remaining = inventory.observed_logical_bytes - selectedBytes;
    return {
      mode: options.mode,
      observed_count: inventory.candidates.length,
      observed_logical_bytes: inventory.observed_logical_bytes,
      opaque_entries: inventory.opaque_entries,
      whole_work_size_known: false,
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
        continue;
      }
      if (refs.protects(path)) {
        retained.protected++;
        continue;
      }
      if (options.before !== undefined && candidate.mtimeMs >= options.before) {
        retained.recent++;
        continue;
      }
      if (!unchanged(root, candidate)) {
        retained.stale++;
        continue;
      }
      if (
        options.targetBytes !== undefined &&
        inventory.observed_logical_bytes - selectedBytes <= options.targetBytes
      ) {
        retained.target++;
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
  }
  try {
    check();
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) context.fatal(error);
    throw new WorkGcInterruptedError(report(), error);
  }
  return report();
}
