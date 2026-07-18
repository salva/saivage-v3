import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { z } from 'zod';

import type { AgentRole } from '../schemas/index.js';
import { buildScopedPathUrl } from '../contracts/scoped-path-url.js';
import { describe } from './tool-definition.js';
import type { ToolContext, ToolResult as AnalystToolResult } from './analyst-tool-types.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolProvider, type ToolResult as InvocationToolResult } from './invocation.js';
import { authorizeWriteProject, writeProject, type WorkspaceContext } from './project-file-tools.js';
import { SAIVAGE_WORK_RELATIVE_DIR } from '../persistence/layout.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { commitFetchedBrief, recheckFetchedBrief } from '../application/analyst-mutation-operations.js';
import { prepareAnalystBriefWebfetch, type PreparedFetchedBrief } from '../application/analyst-prepare/webfetch.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 500_000;
const DEFAULT_MAX_INLINE_BYTES = 100_000;
const MAX_RESULTS = 20;
const MAX_REDIRECTS = 5;

type ReadMode = 'auto' | 'text' | 'multimodal';

export interface WebProviderContext extends WorkspaceContext {
  readonly agentRole: Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>;
  readonly analystToolContext?: ToolContext;
}

const websearchSchema = z.object({ query: z.string(), max_results: z.number().int().optional() }).strict();
const webfetchSchema = z.object({ url: z.string(), read_mode: z.enum(['auto', 'text', 'multimodal']).optional(), metadata_only: z.boolean().optional(), max_bytes: z.number().int().optional(), max_inline_bytes: z.number().int().optional(), save_as: describe(z.string().optional(), 'Optional scoped path to save fetched text content.') }).strict();

function webContext(ctx: ToolContext): WebProviderContext {
  if (ctx.actor === 'planner' || ctx.actor === 'executor' || ctx.actor === 'reviewer' || ctx.actor === 'analyst') return { projectRoot: ctx.projectRoot, agentRole: ctx.actor, store: ctx.store, notifyCard: ctx.runtime ? (cardId, notification) => ctx.runtime!.notifyCard(cardId, notification) : undefined };
  throw new Error(`Unsupported web tool actor '${ctx.actor}'.`);
}

function analystResult(result: InvocationToolResult): AnalystToolResult {
  if (result.success) return result;
  return toolFailure(result.error);
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = url.username ? '[REDACTED]' : '';
    url.password = url.password ? '[REDACTED]' : '';
    url.search = url.search ? '?[REDACTED]' : '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[INVALID_URL]';
  }
}

function parseHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https.');
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  return url;
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower === '::';
}

async function assertPublicHttpTarget(url: URL): Promise<void> {
  const host = url.hostname;
  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error('URL host did not resolve.');
  for (const record of records) {
    const family = net.isIP(record.address);
    if (family === 4 && privateIpv4(record.address)) throw new Error(`Blocked private/internal web target: ${host}.`);
    if (family === 6 && privateIpv6(record.address)) throw new Error(`Blocked private/internal web target: ${host}.`);
    if (family === 0) throw new Error(`Unrecognized resolved address for ${host}.`);
  }
}

function combinedSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]);
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || err === signal.reason || (err instanceof DOMException && err.name === 'AbortError');
}

async function fetchPublic(url: URL, maxBytes: number, signal: AbortSignal, redirects = 0): Promise<{ url: URL; response: Response; body: Uint8Array }> {
  if (redirects > MAX_REDIRECTS) throw new Error('Too many redirects.');
  await assertPublicHttpTarget(url);
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Tool invocation was interrupted.');
  const response = await fetch(url, { redirect: 'manual', signal: combinedSignal(signal), headers: { 'User-Agent': 'Saivage/0.1 agent-web-tool' } });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response did not include Location.');
    const next = parseHttpUrl(new URL(location, url).toString());
    return fetchPublic(next, maxBytes, signal, redirects + 1);
  }
  const reader = response.body?.getReader();
  if (!reader) return { url, response, body: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`Response exceeded max_bytes (${maxBytes}).`);
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { url, response, body };
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['content-type', 'content-length', 'last-modified', 'etag']) {
    const value = headers.get(key);
    if (value) out[key] = value;
  }
  return out;
}

function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function ddgResults(html: string, base: URL, max: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    if (results.length >= max) break;
    try {
      const href = new URL(match[1].replace(/&amp;/g, '&'), base);
      const uddg = href.searchParams.get('uddg');
      const url = uddg ? new URL(uddg) : href;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      results.push({ title: stripHtml(match[2]), url: url.toString(), snippet: '' });
    } catch {
      // Skip malformed search results.
    }
  }
  return results;
}

async function websearchCore(params: { query: string; max_results?: number }, signal: AbortSignal = new AbortController().signal, wait?: <T>(promise: Promise<T>) => Promise<T>): Promise<InvocationToolResult> {
  try {
    const query = params.query.trim();
    if (!query) return { success: false, error: 'query is required.' };
    const max = Math.min(Math.max(params.max_results ?? 10, 1), MAX_RESULTS);
    const url = parseHttpUrl(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const fetchPromise = fetchPublic(url, DEFAULT_MAX_BYTES, signal);
    const fetched = await (wait ? wait(fetchPromise) : fetchPromise);
    if (!fetched.response.ok) return { success: false, error: `Search provider returned HTTP ${fetched.response.status}.` };
    const html = Buffer.from(fetched.body).toString('utf8');
    return { success: true, data: { query, results: ddgResults(html, fetched.url, max) } };
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function webfetchCore(ctx: WebProviderContext, params: { url: string; read_mode?: ReadMode; metadata_only?: boolean; max_bytes?: number; max_inline_bytes?: number; save_as?: string }, signal: AbortSignal = new AbortController().signal, wait?: <T>(promise: Promise<T>) => Promise<T>): Promise<InvocationToolResult> {
  try {
    const url = parseHttpUrl(params.url);
    const maxBytes = Math.min(Math.max(params.max_bytes ?? DEFAULT_MAX_BYTES, 1), 1_000_000);
    if (params.metadata_only && params.save_as) return { success: false, error: 'metadata_only cannot be combined with save_as.' };
    if (params.save_as) authorizeWriteProject(ctx, { path: params.save_as });
    const fetchPromise = fetchPublic(url, params.metadata_only ? 1 : maxBytes, signal);
    const fetched = await (wait ? wait(fetchPromise) : fetchPromise);
    const headers = headersObject(fetched.response.headers);
    const metadata = { url: fetched.url.toString(), redacted_url: redactUrl(fetched.url.toString()), status: fetched.response.status, headers };
    if (params.metadata_only) return { success: true, data: { ...metadata, metadata_only: true } };
    if (!fetched.response.ok) return { success: false, error: `HTTP ${fetched.response.status} for ${redactUrl(fetched.url.toString())}.` };
    const contentType = headers['content-type'] ?? '';
    const mode = params.read_mode ?? 'auto';
    const isText = mode === 'text' || (mode === 'auto' && /^(text\/)|application\/(json|xml|javascript|xhtml\+xml)/i.test(contentType));
    if (!isText) return { success: true, data: { ...metadata, bytes: fetched.body.byteLength, content: null, binary: true } };
    const text = Buffer.from(fetched.body).toString('utf8');
    if (params.save_as) {
      const write = await writeProject(ctx, { path: params.save_as, content: text }) as Record<string, unknown>;
      const savedAs = typeof write.record_url === 'string' ? write.record_url : String(write.path);
      return { success: true, data: { ...metadata, saved_as: savedAs, write, bytes: Buffer.byteLength(text, 'utf8') } };
    }
    const inlineCap = Math.min(Math.max(params.max_inline_bytes ?? DEFAULT_MAX_INLINE_BYTES, 1), maxBytes);
    if (Buffer.byteLength(text, 'utf8') <= inlineCap) return { success: true, data: { ...metadata, text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false } };
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const filename = `webfetch-${Date.now()}-${hash}.txt`;
    const stash = `${SAIVAGE_WORK_RELATIVE_DIR}/tmp/stash/${filename}`;
    const absolute = join(ctx.projectRoot, stash);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
    return { success: true, data: { ...metadata, stash_url: buildScopedPathUrl('work', ['tmp', 'stash', filename]), bytes: Buffer.byteLength(text, 'utf8'), truncated: true } };
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchAnalystBrief(input: { url: string; read_mode?: ReadMode; max_bytes?: number }, signal: AbortSignal): Promise<PreparedFetchedBrief> {
  const url = parseHttpUrl(input.url);
  const maxBytes = Math.min(Math.max(input.max_bytes ?? DEFAULT_MAX_BYTES, 1), 1_000_000);
  const fetched = await fetchPublic(url, maxBytes, signal);
  const headers = headersObject(fetched.response.headers);
  const metadata = { url: fetched.url.toString(), redacted_url: redactUrl(fetched.url.toString()), status: fetched.response.status, headers };
  if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status} for ${redactUrl(fetched.url.toString())}.`);
  const contentType = headers['content-type'] ?? '';
  const mode = input.read_mode ?? 'auto';
  const isText = mode === 'text' || (mode === 'auto' && /^(text\/)|application\/(json|xml|javascript|xhtml\+xml)/i.test(contentType));
  if (!isText) throw new Error('Analyst brief record webfetch requires a text response.');
  return { content: Buffer.from(fetched.body).toString('utf8'), metadata };
}

export async function websearch(_ctx: ToolContext, params: { query: string; max_results?: number }): Promise<AnalystToolResult> {
  return analystResult(await websearchCore(params));
}

export async function webfetch(ctx: ToolContext, params: { url: string; read_mode?: ReadMode; metadata_only?: boolean; max_bytes?: number; max_inline_bytes?: number; save_as?: string }): Promise<AnalystToolResult> {
  try {
    return analystResult(await webfetchCore(webContext(ctx), params));
  } catch (err) {
    return toolFailureFromError(err, err instanceof Error ? err.message : String(err));
  }
}

export function createWebProvider(ctx: WebProviderContext): ToolProvider {
  return {
    providerName: 'web',
    tools: [
      defineTool({
        name: 'websearch',
        description: 'Search the public web for documentation and data sources.',
        inputSchema: websearchSchema,
        executor: async (args, signal, invocation) => websearchCore(args, signal, invocation?.waits.waitExternal),
      }),
      defineTool({
        name: 'webfetch',
        description: 'Fetch a public HTTP(S) URL with bounded size and private-network protections. Oversized text is stashed as stash_url, a work:///tmp/stash/<file> URL readable with read or grep.',
        inputSchema: webfetchSchema,
        executor: async (args, signal, invocation) => {
          const analyst = ctx.analystToolContext;
          if (!analyst || !args.save_as?.startsWith('record:///')) return webfetchCore(ctx, args, signal, invocation?.waits.waitExternal);
          const preparedContext: ToolContext = { ...analyst, analystPreparation: { web: { fetchText: (input) => {
            const pending = fetchAnalystBrief(input, signal);
            return invocation ? invocation.waits.waitExternal(pending) : pending;
          } } } };
          return runAuditedAnalystTool(preparedContext, { url: args.url, read_mode: args.read_mode, max_bytes: args.max_bytes, save_as: args.save_as }, {
            action: 'record.write', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.save_as, lifecycle: 'intervention_ready',
            prepare: prepareAnalystBriefWebfetch, recheck: recheckFetchedBrief, commit: commitFetchedBrief,
          }, signal);
        },
      }),
    ],
  };
}
