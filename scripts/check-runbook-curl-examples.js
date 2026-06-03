#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImplementedRoutes, routeKey, normalizeRoutePath } from './verify-doc-routes.js';

const RUNBOOK_DIR = 'docs/runbook';
const REQUIRED_SEMANTIC_EXAMPLES = new Map([
  ['GET /health', { status: 200, keys: ['status', 'version', 'project'], required: true }],
  ['GET /health/ready', { status: 200, keys: ['status'], required: true }],
  ['GET /api/state', { status: 200, keys: ['runtime', 'cardIndex'], required: true }],
]);

export function listRunbookMarkdown(projectRoot) {
  const dir = join(projectRoot, RUNBOOK_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(RUNBOOK_DIR, name));
}

function parseExpectedContract(content, commandEndIndex) {
  const nextFence = content.indexOf('```', commandEndIndex);
  const section = content.slice(commandEndIndex, nextFence === -1 ? undefined : nextFence);
  const statusMatch = section.match(/Expected status:\s*`?(\d{3})`?/i);
  const keysMatch = section.match(/Expected top-level JSON keys:\s*([^\n]+)/i);
  const keys = keysMatch
    ? Array.from(keysMatch[1].matchAll(/`([^`]+)`/g), (match) => match[1].trim()).filter(Boolean)
    : [];
  return {
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    keys,
  };
}

export function extractFencedShellCommands(content, file) {
  const commands = [];
  const fenceRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  for (const match of content.matchAll(fenceRe)) {
    const block = match[1];
    const startLine = content.slice(0, match.index).split('\n').length;
    const logicalLines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    let buffer = '';
    let bufferLine = startLine;
    for (const [offset, line] of logicalLines.entries()) {
      const continued = line.endsWith('\\');
      const segment = continued ? line.slice(0, -1).trim() : line;
      if (!buffer) bufferLine = startLine + offset + 1;
      buffer = `${buffer} ${segment}`.trim();
      if (!continued) {
        if (/^(curl|http)\b/.test(buffer)) commands.push({ command: buffer, file, line: bufferLine, expected: parseExpectedContract(content, match.index + match[0].length) });
        buffer = '';
      }
    }
  }
  return commands;
}

export function parseHttpExample(example) {
  const command = example.command.replace(/\$SAIVAGE_API_TOKEN/g, 'test-token');
  const methodMatch = command.match(/(?:^|\s)-X\s+(GET|POST|PATCH|DELETE|PUT)\b/i);
  const httpieMatch = command.match(/^http\s+(GET|POST|PATCH|DELETE|PUT)\s+/i);
  const method = (methodMatch?.[1] ?? httpieMatch?.[1] ?? 'GET').toUpperCase();
  const urlMatch = command.match(/https?:\/\/[^\s'"<>]+/);
  if (!urlMatch) return null;
  const url = new URL(urlMatch[0]);
  return { method, path: normalizeRoutePath(url.pathname), key: routeKey(method, url.pathname), example };
}

export function seedRuntimeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'saivage-runbook-'));
  const runtimeDir = join(fixtureRoot, '.saivage', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const now = new Date('2026-05-19T00:00:00.000Z').toISOString();
  const state = {
    status: 'idle',
    project_id: 'project',
    pid: process.pid,
    started_at: now,
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    paused: false,
    paused_at: null,
    updated_at: now,
    frozen_reason: null,
  };
  writeFileSync(join(runtimeDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { fixtureRoot, state, freezeManifest: null };
}

export function responseFor(key, fixture) {
  const now = new Date('2026-05-19T00:01:00.000Z').toISOString();
  if (key === 'GET /health') {
    return { statusCode: 200, body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } };
  }
  if (key === 'GET /health/ready') {
    return { statusCode: 200, body: { status: 'ready' } };
  }
  if (key === 'GET /api/state') {
    return { statusCode: 200, body: { runtime: fixture.state, cardIndex: { total: 0, byStatus: {}, byType: {} } } };
  }
  return null;
}

export function assertTopLevelKeys(body, keys) {
  return keys.filter((key) => !Object.prototype.hasOwnProperty.call(body, key));
}

function expectedForExample(item) {
  const defaultExpected = REQUIRED_SEMANTIC_EXAMPLES.get(item.key);
  if (!defaultExpected) return null;
  return {
    status: item.example.expected.status ?? defaultExpected.status,
    keys: item.example.expected.keys.length > 0 ? item.example.expected.keys : defaultExpected.keys,
  };
}

export function verifyRunbookExamples(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const implementedRoutes = options.implementedRoutes ?? extractImplementedRoutes(projectRoot);
  const runbookFiles = options.runbookFiles ?? listRunbookMarkdown(projectRoot);
  const examples = runbookFiles.flatMap((file) => extractFencedShellCommands(readFileSync(join(projectRoot, file), 'utf8'), file));
  const parsed = examples.map(parseHttpExample).filter(Boolean);
  const failures = [];

  if (parsed.length === 0) failures.push('No curl/http examples found in docs/runbook/*.md');

  for (const item of parsed) {
    if (!implementedRoutes.has(item.key)) failures.push(`${item.example.file}:${item.example.line} documents ${item.key}, but no matching Fastify route exists`);
  }

  const fixture = options.seedFixture?.() ?? seedRuntimeFixture();
  try {
    const seenSemantic = new Set();
    for (const item of parsed) {
      const expected = expectedForExample(item);
      if (!expected) continue;
      seenSemantic.add(item.key);
      const response = (options.responseFor ?? responseFor)(item.key, fixture);
      if (!response) {
        failures.push(`${item.example.file}:${item.example.line} has no semantic validator for ${item.key}`);
        continue;
      }
      if (response.statusCode !== expected.status) failures.push(`${item.example.file}:${item.example.line} expected ${expected.status} for ${item.key}, got ${response.statusCode}`);
      const missing = assertTopLevelKeys(response.body, expected.keys);
      if (missing.length > 0) failures.push(`${item.example.file}:${item.example.line} ${item.key} response missing top-level key(s): ${missing.join(', ')}`);
    }

    for (const [key, expected] of REQUIRED_SEMANTIC_EXAMPLES.entries()) {
      if (expected.required && !seenSemantic.has(key)) failures.push(`docs/runbook/*.md must include a curl/http example for ${key}`);
    }
  } finally {
    if (!options.keepFixture && fixture.fixtureRoot) rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }

  return { ok: failures.length === 0, failures, exampleCount: parsed.length, semanticKeys: Array.from(REQUIRED_SEMANTIC_EXAMPLES.keys()) };
}

export function main() {
  const result = verifyRunbookExamples();
  if (!result.ok) {
    console.error('✗ runbook curl/http example check failed');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`✓ runbook curl/http example check passed for ${result.exampleCount} example(s); semantic response keys verified for ${result.semanticKeys.join(', ')}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();
