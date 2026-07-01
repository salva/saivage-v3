import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { isWriteBlocked, looksLikeSecretPath, resolveContainedProjectPath } from '../workspace/index.js';
import { defineTool, type ToolProvider, type ToolResult as InvocationToolResult } from './invocation.js';
import type { AgentRole } from './tool-catalog.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 500_000;
const DEFAULT_MAX_INLINE_BYTES = 100_000;
const MAX_RESULTS = 20;
const MAX_REDIRECTS = 5;

type ReadMode = 'auto' | 'text' | 'multimodal';

export interface WebProviderContext {
  readonly projectRoot: string;
  readonly cardId?: string;
  readonly agentRole: Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>;
}

const websearchSchema = z.object({ query: z.string(), max_results: z.number().int().optional() }).strict();
const webfetchSchema = z.object({ url: z.string(), read_mode: z.enum(['auto', 'text', 'multimodal']).optional(), metadata_only: z.boolean().optional(), max_bytes: z.number().int().optional(), max_inline_bytes: z.number().int().optional(), save_as: describe(z.string().optional(), 'Optional project-relative path to save fetched text content.') }).strict();

function toolContext(ctx: WebProviderContext): ToolContext {
  return { projectRoot: ctx.projectRoot, store: {} as never, actor: ctx.agentRole, surface: 'runtime' };
}

function invocationResult(result: ToolResult): InvocationToolResult {
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error ?? result.errorEnvelope?.message ?? 'Tool failed.' };
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

async function fetchPublic(url: URL, maxBytes: number, redirects = 0): Promise<{ url: URL; response: Response; body: Uint8Array }> {
  if (redirects > MAX_REDIRECTS) throw new Error('Too many redirects.');
  await assertPublicHttpTarget(url);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS), headers: { 'User-Agent': 'Saivage/0.1 agent-web-tool' } });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response did not include Location.');
    const next = parseHttpUrl(new URL(location, url).toString());
    return fetchPublic(next, maxBytes, redirects + 1);
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

function authorizeSavePath(projectRoot: string, path: string): { absolutePath: string; relativePath: string } {
  const resolved = resolveContainedProjectPath(projectRoot, path);
  if (!resolved.safe || !resolved.relativePath) throw new Error(resolved.reason ?? 'save_as must resolve inside the project root.');
  if (resolved.relativePath === '.saivage' || resolved.relativePath.startsWith('.saivage/') || resolved.relativePath === '.saivage-work' || resolved.relativePath.startsWith('.saivage-work/')) throw new Error('save_as cannot modify Saivage internal state directories.');
  if (isWriteBlocked(resolved.relativePath) || looksLikeSecretPath(resolved.absolutePath)) throw new Error(`save_as path '${resolved.relativePath}' is blocked for security reasons.`);
  return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

export async function websearch(_ctx: ToolContext, params: { query: string; max_results?: number }): Promise<ToolResult> {
  try {
    const query = params.query.trim();
    if (!query) return toolFailure('validation', 'query is required.', { field: 'query' });
    const max = Math.min(Math.max(params.max_results ?? 10, 1), MAX_RESULTS);
    const url = parseHttpUrl(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const fetched = await fetchPublic(url, DEFAULT_MAX_BYTES);
    if (!fetched.response.ok) return toolFailure('provider', `Search provider returned HTTP ${fetched.response.status}.`, { status: fetched.response.status });
    const html = Buffer.from(fetched.body).toString('utf8');
    return { success: true, data: { query, results: ddgResults(html, fetched.url, max) } };
  } catch (err) {
    return toolFailureFromError(err, 'provider', err instanceof Error ? err.message : String(err));
  }
}

export async function webfetch(ctx: ToolContext, params: { url: string; read_mode?: ReadMode; metadata_only?: boolean; max_bytes?: number; max_inline_bytes?: number; save_as?: string }): Promise<ToolResult> {
  try {
    const url = parseHttpUrl(params.url);
    const maxBytes = Math.min(Math.max(params.max_bytes ?? DEFAULT_MAX_BYTES, 1), 1_000_000);
    if (params.metadata_only && params.save_as) return toolFailure('validation', 'metadata_only cannot be combined with save_as.');
    if (params.save_as && ctx.actor === 'reviewer') return toolFailure('permission', 'reviewer cannot use webfetch save_as.');
    const fetched = await fetchPublic(url, params.metadata_only ? 1 : maxBytes);
    const headers = headersObject(fetched.response.headers);
    const metadata = { url: fetched.url.toString(), redacted_url: redactUrl(fetched.url.toString()), status: fetched.response.status, headers };
    if (params.metadata_only) return { success: true, data: { ...metadata, metadata_only: true } };
    if (!fetched.response.ok) return toolFailure('provider', `HTTP ${fetched.response.status} for ${redactUrl(fetched.url.toString())}.`, { status: fetched.response.status });
    const contentType = headers['content-type'] ?? '';
    const mode = params.read_mode ?? 'auto';
    const isText = mode === 'text' || (mode === 'auto' && /^(text\/)|application\/(json|xml|javascript|xhtml\+xml)/i.test(contentType));
    if (!isText) return { success: true, data: { ...metadata, bytes: fetched.body.byteLength, content: null, binary: true } };
    const text = Buffer.from(fetched.body).toString('utf8');
    if (params.save_as) {
      const target = authorizeSavePath(ctx.projectRoot, params.save_as);
      mkdirSync(dirname(target.absolutePath), { recursive: true });
      writeFileSync(target.absolutePath, text, 'utf8');
      return { success: true, data: { ...metadata, saved_as: target.relativePath, bytes: Buffer.byteLength(text, 'utf8') } };
    }
    const inlineCap = Math.min(Math.max(params.max_inline_bytes ?? DEFAULT_MAX_INLINE_BYTES, 1), maxBytes);
    if (Buffer.byteLength(text, 'utf8') <= inlineCap) return { success: true, data: { ...metadata, text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false } };
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const stash = `.saivage-work/tmp/stash/webfetch-${Date.now()}-${hash}.txt`;
    const absolute = join(ctx.projectRoot, stash);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
    return { success: true, data: { ...metadata, stash_path: stash, bytes: Buffer.byteLength(text, 'utf8'), truncated: true } };
  } catch (err) {
    return toolFailureFromError(err, 'provider', err instanceof Error ? err.message : String(err));
  }
}

export const webTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'websearch', description: 'Search the public web for documentation and data sources.', input: websearchSchema, roles: ['planner', 'executor', 'reviewer'], executor: websearch },
  { name: 'webfetch', description: 'Fetch a public HTTP(S) URL with bounded size and private-network protections.', input: webfetchSchema, roles: ['planner', 'executor', 'reviewer'], executor: webfetch },
] as const;

export function createWebProvider(ctx: WebProviderContext): ToolProvider {
  return {
    providerName: 'web',
    tools: [
      defineTool({
        name: 'websearch',
        description: 'Search the public web for documentation and data sources.',
        inputSchema: websearchSchema,
        executor: async (args) => invocationResult(await websearch(toolContext(ctx), args)),
      }),
      defineTool({
        name: 'webfetch',
        description: 'Fetch a public HTTP(S) URL with bounded size and private-network protections.',
        inputSchema: webfetchSchema,
        executor: async (args) => invocationResult(await webfetch(toolContext(ctx), args)),
      }),
    ],
  };
}
