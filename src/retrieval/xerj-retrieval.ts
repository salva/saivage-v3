import { z } from 'zod';
import { resolve } from 'node:path';
import type { ObservedChannel } from '../contracts/index.js';
import type { ObservedDeployment } from './collection-definitions.js';

const hitSchema = z.object({ _id: z.string(), _source: z.record(z.string(), z.unknown()) });
const searchSchema = z.object({ hits: z.object({ hits: z.array(hitSchema) }) });
interface NativeDestination {
  index: string;
  root: string;
  run: string;
}
export interface NativeCandidate {
  root: string;
  source: Record<string, unknown>;
  channel: ObservedChannel;
  ordinal: number;
}
export class NativeQueryFailure extends Error {
  constructor() {
    super('Observed source query unavailable.');
  }
}

/** Request-local protocol owner. All native response bytes stay private. */
export class XerjRetrieval {
  constructor(
    private readonly deployment: ObservedDeployment,
    private readonly key: string,
    private readonly projectRoot: string,
  ) {}

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${this.deployment.endpoint}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new NativeQueryFailure();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new NativeQueryFailure();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new NativeQueryFailure();
    }
  }

  async destinations(
    directories: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<{ items: NativeDestination[]; limited: boolean }> {
    // A dataset's run_id joins the native run's exact root AND adopted prefix.
    // Neither dataset spelling nor prefix alone grants source attribution.
    const runs = new Map<string, string>();
    const selected = this.deployment.roots.filter((r) => directories.has(r.directory));
    const runPage = searchSchema.parse(
      await this.request('/autoindex-catalog/_search', signal, {
        size: 200,
        query: {
          bool: {
            filter: [
              { term: { doc_kind: 'run' } },
              { terms: { prefix: selected.map((r) => r.prefix) } },
            ],
          },
        },
        sort: [{ started: 'desc' }],
        _source: ['run_id', 'root', 'prefix'],
      }),
    );
    for (const { _source: row } of runPage.hits.hits.slice(0, 200)) {
      const root = selected.find(
        (r) => row.prefix === r.prefix && row.root === resolve(this.projectRoot, r.directory),
      );
      if (root && typeof row.run_id === 'string') runs.set(row.run_id, root.directory);
    }
    if (!runs.size) return { items: [], limited: runPage.hits.hits.length >= 200 };
    const page = searchSchema.parse(
      await this.request('/autoindex-catalog/_search', signal, {
        size: 200,
        query: {
          bool: {
            filter: [{ term: { doc_kind: 'dataset' } }, { terms: { run_id: [...runs.keys()] } }],
          },
        },
        _source: ['index_name', 'run_id'],
      }),
    );
    const items: NativeDestination[] = [];
    for (const { _source: row } of page.hits.hits.slice(0, 200)) {
      if (typeof row.run_id !== 'string' || typeof row.index_name !== 'string')
        throw new NativeQueryFailure();
      const root = runs.get(row.run_id);
      if (!root || !/^[a-z0-9][a-z0-9_-]*$/u.test(row.index_name)) throw new NativeQueryFailure();
      if (!items.some((d) => d.index === row.index_name && d.root === root))
        items.push({ index: row.index_name, root, run: row.run_id });
    }
    return {
      items: items.slice(0, 32),
      limited: items.length > 32 || page.hits.hits.length >= 200 || runPage.hits.hits.length >= 200,
    };
  }

  async fields(
    destination: NativeDestination,
    signal: AbortSignal,
  ): Promise<{ lexical: string[]; neural: string[] }> {
    const mappings = z
      .record(
        z.string(),
        z.object({
          mappings: z.object({
            properties: z.record(z.string(), z.object({ type: z.string().optional() })),
          }),
        }),
      )
      .parse(await this.request(`/${encodeURIComponent(destination.index)}/_mapping`, signal));
    const properties = mappings[destination.index]?.mappings.properties;
    if (!properties) throw new NativeQueryFailure();
    // Fixed-pin text carriers only; arbitrary inferred columns are not outward evidence.
    const lexical = ['body', 'impl', 'text', 'name', 'title'].filter((name) =>
      ['text', 'keyword', 'semantic_text'].includes(properties[name]?.type ?? ''),
    );
    const neural = ['body', 'impl', 'text'].filter(
      (name) => properties[name]?.type === 'semantic_text',
    );
    return { lexical, neural };
  }

  async search(
    destination: NativeDestination,
    channel: ObservedChannel,
    fields: string[],
    query: string,
    size: number,
    signal: AbortSignal,
  ): Promise<{ candidates: NativeCandidate[]; limited: boolean }> {
    const clauses = fields.map((field) => ({ match: { [field]: query } }));
    // Pinned peel_semantic_query reaches vectors only for one semantic clause.
    // Never label a multi-clause bool's lexical fallback as neural execution.
    const requests =
      channel === 'lexical'
        ? [
            {
              size,
              query:
                clauses.length === 1
                  ? clauses[0]
                  : { bool: { should: clauses, minimum_should_match: 1 } },
            },
          ]
        : fields
            .map((field, index) => {
              const count =
                Math.floor(size / fields.length) + (index < size % fields.length ? 1 : 0);
              return { size: count, query: { semantic: { field, query, k: count } } };
            })
            .filter((request) => request.size > 0);
    const candidates: NativeCandidate[] = [];
    let limited = false;
    for (const [fieldIndex, request] of requests.entries()) {
      const page = searchSchema.parse(
        await this.request(`/${encodeURIComponent(destination.index)}/_search`, signal, {
          ...request,
          _source: [
            'body',
            'impl',
            'text',
            'ax_path',
            'ax_paths',
            'ax_file',
            'ax_run',
            'ax_locator',
          ],
        }),
      );
      if (page.hits.hits.length >= request.size) limited = true;
      candidates.push(
        ...page.hits.hits.slice(0, request.size).map((hit, index) => ({
          root: destination.root,
          source: hit._source,
          channel,
          ordinal: index * requests.length + fieldIndex + 1,
        })),
      );
    }
    return { candidates: candidates.sort((a, b) => a.ordinal - b.ordinal), limited };
  }
}
