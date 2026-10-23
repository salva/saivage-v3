import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ObservedHit,
  ObservedQuery,
  ObservedResult,
  RetrievalCaller,
  RetrievalPort,
} from '../contracts/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { inspectAgentReadPath } from '../workspace/index.js';
import {
  readObservedCollections,
  readObservedDeployment,
  readXerjKey,
  type ObservedCollections as CollectionDefinitions,
} from './collection-definitions.js';
import { NativeQueryFailure, XerjRetrieval, type NativeCandidate } from './xerj-retrieval.js';

function matches(pattern: string, path: string): boolean {
  const parts = pattern.split('/');
  const expression = parts
    .map((part, i) =>
      part === '**'
        ? i === parts.length - 1
          ? '.*'
          : '(?:[^/]+/)*'
        : part
            .split('*')
            .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*') + (i < parts.length - 1 ? '/' : ''),
    )
    .join('');
  return new RegExp(`^${expression}$`, 'u').test(path);
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function clipped(text: string, bytes: number): string {
  let result = '';
  let length = 0;
  for (const character of text) {
    length += Buffer.byteLength(character);
    if (length > bytes) break;
    result += character;
  }
  return result;
}
function emptyResult(): ObservedResult {
  return {
    collections: [],
    hits: [],
    coverage: {
      exhaustive: false,
      failed_channels: [],
      unavailable_channels: [],
      candidate_limit_reached: false,
      postfilter_removals: false,
      output_truncated: false,
      limitations: ['observations_may_be_stale', 'embedding_coverage_unknown'],
    },
  };
}
function boundResult(result: ObservedResult): ObservedResult {
  while (Buffer.byteLength(JSON.stringify(result)) > 32000 && result.hits.length) {
    result.hits.pop();
    result.coverage.output_truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 32000) {
    for (const status of result.collections) status.purpose = clipped(status.purpose, 256);
    result.coverage.output_truncated = true;
  }
  return result;
}

export function createObservedCollections(projectRoot: string): RetrievalPort {
  const definitions = readObservedCollections(projectRoot);
  if (!definitions || !definitions.collections.length)
    return new ObservedCollections(
      projectRoot,
      { format_version: 1, type: 'observed-collections', collections: [] },
      null,
    );
  const deployment = readObservedDeployment(projectRoot);
  const canonical = realpathSync(projectRoot);
  const collections = definitions.collections.map((collection) => {
    const actual = realpathSync(resolve(canonical, collection.directory));
    if (
      !contained(canonical, actual) ||
      actual.split(sep).includes('.git') ||
      inspectAgentReadPath(actual).blocked ||
      !statSync(actual).isDirectory()
    )
      throw new Error('Invalid observed collection root.');
    const directory = relative(canonical, actual).split(sep).join('/') || '.';
    if (!deployment.roots.some((root) => root.directory === directory))
      throw new Error('Observed collection root has not been adopted.');
    return { ...collection, directory };
  });
  return new ObservedCollections(
    canonical,
    { ...definitions, collections },
    new XerjRetrieval(deployment, readXerjKey(projectRoot), canonical),
  );
}

class ObservedCollections implements RetrievalPort {
  constructor(
    private readonly projectRoot: string,
    private readonly definitions: CollectionDefinitions,
    private readonly native: XerjRetrieval | null,
  ) {}

  list(caller: RetrievalCaller, signal: AbortSignal): Promise<ObservedResult> {
    return this.run(undefined, caller, signal);
  }
  query(
    input: ObservedQuery,
    caller: RetrievalCaller,
    signal: AbortSignal,
  ): Promise<ObservedResult> {
    return this.run(input, caller, signal);
  }

  private project(
    candidate: NativeCandidate,
    selected: CollectionDefinitions['collections'],
    caller: RetrievalCaller,
  ): Omit<ObservedHit, 'rank' | 'channels'> | null {
    const source = candidate.source;
    // The pinned extractor stamps body/impl/text on content-id grouped records; ax_paths
    // is the same-byte group's aliases. Do not expose arbitrary inferred columns.
    if (
      typeof source.ax_path !== 'string' ||
      typeof source.ax_locator !== 'string' ||
      typeof source.ax_file !== 'string' ||
      !/^axf2-[a-f0-9]{32}-[a-f0-9]+(?:-collision-[a-f0-9]{32})?$/u.test(source.ax_file)
    )
      return null;
    const aliases =
      Array.isArray(source.ax_paths) && source.ax_paths.every((p) => typeof p === 'string')
        ? (source.ax_paths as string[])
        : [source.ax_path];
    const memberships: ObservedHit['memberships'] = [];
    for (const alias of aliases) {
      if (
        isAbsolute(alias) ||
        alias.split('/').some((p) => !p || p === '.' || p === '..') ||
        alias.includes('\\')
      )
        continue;
      const absolute = resolve(this.projectRoot, candidate.root, alias);
      try {
        if (!contained(resolve(this.projectRoot, candidate.root), absolute)) continue;
        const permitted = caller.resolveReadablePath(absolute);
        if (inspectAgentReadPath(permitted).blocked) continue;
        const actual = realpathSync(permitted);
        if (
          !contained(resolve(this.projectRoot, candidate.root), actual) ||
          actual.split(sep).includes('.git') ||
          !statSync(actual).isFile()
        )
          continue;
        accessSync(actual, constants.R_OK);
        const local = relative(resolve(this.projectRoot, candidate.root), actual)
          .split(sep)
          .join('/');
        const path = relative(this.projectRoot, actual).split(sep).join('/');
        // Redacted path text cannot be used as a safe navigation identity.
        if (redactTextForOutbound(path) !== path) continue;
        for (const collection of selected) {
          if (
            collection.directory !== candidate.root ||
            !collection.include.some((p) => matches(p, local)) ||
            collection.exclude.some((p) => matches(p, local))
          )
            continue;
          if (!memberships.some((m) => m.collection === collection.name && m.path === path))
            memberships.push({ collection: collection.name, path });
        }
      } catch {
        /* Missing, moved or forbidden original: no alternate discovery. */
      }
    }
    if (!memberships.length) return null;
    const text =
      typeof source.impl === 'string'
        ? source.impl
        : typeof source.body === 'string'
          ? source.body
          : typeof source.text === 'string'
            ? source.text
            : null;
    if (text === null) return null;
    const safe = redactTextForOutbound(text);
    return {
      memberships,
      excerpt: clipped(safe, 2048),
      excerpt_truncated: Buffer.byteLength(safe) > 2048,
      transformed: safe !== text,
      location: 'unavailable',
    };
  }

  private async run(
    input: ObservedQuery | undefined,
    caller: RetrievalCaller,
    invocation: AbortSignal,
  ): Promise<ObservedResult> {
    const result = emptyResult();
    const selected = this.definitions.collections.filter(
      (c) => !input || input.collections.includes(c.name),
    );
    if (input && selected.length !== input.collections.length)
      throw new Error('Unknown observed collection.');
    const allowed = selected.filter((c) => {
      try {
        caller.resolveReadablePath(resolve(this.projectRoot, c.directory));
        return true;
      } catch {
        return false;
      }
    });
    if (allowed.length !== selected.length && input)
      throw new Error('Observed collection is not permitted.');
    result.collections = allowed.map((c) => ({
      name: c.name,
      purpose: redactTextForOutbound(c.purpose),
      kind: c.kind,
      queryability: 'initializing',
      coverage: 'unknown',
      limitations: [],
    }));
    if (!this.native || !allowed.length) return result;
    const signal = AbortSignal.any([invocation, AbortSignal.timeout(15000)]);
    try {
      const selection = await this.native.destinations(
        new Set(allowed.map((c) => c.directory)),
        signal,
      );
      if (selection.limited) result.coverage.limitations.push('catalog_selection_limited');
      const fused = new Map<string, { hit: Omit<ObservedHit, 'rank'>; score: number }>();
      let remaining = 1600;
      let successful = 0;
      let attempted = 0;
      for (const destination of selection.items) {
        signal.throwIfAborted();
        const statuses = result.collections.filter((s) =>
          allowed.some((c) => c.name === s.name && c.directory === destination.root),
        );
        let fields: { lexical: string[]; neural: string[] };
        try {
          fields = await this.native.fields(destination, signal);
        } catch {
          for (const s of statuses) {
            if (s.queryability !== 'available') s.queryability = 'unavailable';
            s.coverage = 'unknown';
            s.limitations.push('metadata_unavailable');
          }
          if (!result.coverage.limitations.includes('metadata_unavailable'))
            result.coverage.limitations.push('metadata_unavailable');
          continue;
        }
        for (const s of statuses) {
          if (fields.lexical.length || fields.neural.length) s.queryability = 'available';
          else if (s.queryability !== 'available') s.queryability = 'unavailable';
          if (!s.limitations.includes('metadata_unavailable')) s.coverage = 'incomplete';
          if (!fields.lexical.length) s.limitations.push('lexical_fields_absent');
        }
        if (!fields.neural.length) {
          for (const s of statuses) s.limitations.push('semantic_fields_absent');
          if (!result.coverage.unavailable_channels.includes('neural'))
            result.coverage.unavailable_channels.push('neural');
        }
        if (!input) continue;
        for (const channel of ['lexical', 'neural'] as const) {
          if (!fields[channel].length) continue;
          if (!remaining) {
            result.coverage.candidate_limit_reached = true;
            break;
          }
          attempted++;
          const size = Math.min(200, remaining);
          remaining -= size;
          let candidates: NativeCandidate[];
          try {
            const page = await this.native.search(
              destination,
              channel,
              fields[channel],
              input.query,
              size,
              signal,
            );
            candidates = page.candidates;
            result.coverage.candidate_limit_reached ||= page.limited;
            successful++;
          } catch {
            if (!result.coverage.failed_channels.includes(channel))
              result.coverage.failed_channels.push(channel);
            continue;
          }
          for (const candidate of candidates) {
            const projection = this.project(candidate, allowed, caller);
            if (!projection) {
              result.coverage.postfilter_removals = true;
              continue;
            }
            const key = JSON.stringify([
              candidate.root,
              candidate.source.ax_file,
              candidate.source.ax_locator,
              projection.memberships,
              projection.excerpt,
            ]);
            const weight =
              (input.intent === 'conceptual' && channel === 'neural') ||
              (input.intent === 'identifier' && channel === 'lexical')
                ? 2
                : 1;
            const entry = fused.get(key) ?? { hit: { ...projection, channels: [] }, score: 0 };
            if (!entry.hit.channels.includes(channel)) {
              entry.score += weight / (60 + candidate.ordinal);
              entry.hit.channels.push(channel);
            }
            fused.set(key, entry);
          }
        }
      }
      signal.throwIfAborted();
      if (
        input &&
        ((attempted && !successful) ||
          (selection.items.length &&
            result.collections.every((s) => s.queryability === 'unavailable')))
      )
        throw new NativeQueryFailure();
      if (result.coverage.postfilter_removals)
        result.coverage.limitations.push('eligible_results_may_be_starved');
      const hits = [...fused.values()].sort((a, b) => b.score - a.score);
      result.coverage.output_truncated =
        hits.length > (input?.limit ?? 20) || hits.some((entry) => entry.hit.excerpt_truncated);
      result.hits = hits
        .slice(0, input?.limit ?? 20)
        .map((entry, index) => ({ ...entry.hit, rank: index + 1 }));
      for (const status of result.collections)
        status.limitations = [...new Set(status.limitations)].sort();
      return boundResult(result);
    } catch {
      if (!input && !signal.aborted) {
        for (const status of result.collections) {
          status.queryability = 'unavailable';
          status.limitations = ['native_unavailable'];
        }
        return boundResult(result);
      }
      throw new NativeQueryFailure();
    }
  }
}
