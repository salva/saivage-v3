import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';
import { CardService } from '../../src/cards/card-service.js';
import { cardNamespace } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

function cardFilesReader(cards: CardService) {
  return {
    record: cards.recordReader.record,
    getCanonicalCard: (id: string) => cards.getCanonicalCard(id),
    getCanonicalCardChildren: (id: string) => cards.getCanonicalCardChildren(id),
    getCanonicalCardFilesMetadata: (id: string) => cards.getCanonicalCardFilesMetadata(id),
    getCanonicalCardFileContent: (id: string, slot: 'card' | 'brief' | 'status' | 'review', maximumBytes: number) => cards.getCanonicalCardFileContent(id, slot, maximumBytes),
  };
}

const records = () => ({
  record: (_cardId: string, _filename: string, _version: number | 'latest' | 'open') => { throw new Error('No records in workspace file tests.'); },
  getCanonicalCard: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardChildren: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardFilesMetadata: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardFileContent: () => ({ kind: 'card-not-found' as const }),
});

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'saivage-workspace-files-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function listedNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return [];
  return body.files.map((file: unknown) => {
    if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string') throw new Error('Listed file is missing its name.');
    return file.name;
  });
}

describe('WorkspaceFileReadModelService work URLs', () => {
  it('reads process logs and stash files through canonical work URLs', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    mkdirSync(join(root, '.saivage/work', 'tmp', 'stash'), { recursive: true });
    writeFileSync(join(root, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'stdout token=process-secret', 'utf8');
    writeFileSync(join(root, '.saivage/work', 'tmp', 'stash', 'webfetch.txt'), 'stashed apiKey=stash-secret', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('work:///processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log', content: 'stdout token=[REDACTED]', redacted: true, sensitivity: 'sensitive-redacted' }) }));
    expect(service.readFileContent('work:///tmp/stash/webfetch.txt')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///tmp/stash/webfetch.txt', content: 'stashed apiKey=[REDACTED]', redacted: true, sensitivity: 'sensitive-redacted' }) }));
    expect(service.readFileContent('.saivage/work/processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: '.saivage/work/processes/proc-1/stdout.log', content: 'stdout token=[REDACTED]', redacted: true, sensitivity: 'sensitive-redacted' }) }));
  }));

  it('omits and rejects blocked work paths while preserving ordinary work files', () => withRoot((root) => {
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(join(workRoot, '.env'), 'synthetic blocked value', 'utf8');
    writeFileSync(join(workRoot, 'stdout.log'), 'stdout output', 'utf8');
    symlinkSync('.env', join(workRoot, 'safe-alias.log'));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    const listing = service.listFiles('work:///processes/proc-1');
    expect(listing.body).toEqual(expect.objectContaining({
      files: [expect.objectContaining({ name: 'stdout.log', path: 'work:///processes/proc-1/stdout.log' })],
    }));
    expect(service.readFileContent('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/safe-alias.log').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/stdout.log')).toEqual(expect.objectContaining({ body: expect.objectContaining({ content: 'stdout output', redacted: true, sensitivity: 'sensitive-redacted' }) }));
  }));

  it('projects a custom selected config directly through its lexical path and contained alias', () => withRoot((root) => {
    const relativePath = 'config/custom-selected.yaml';
    const selectedPath = join(root, relativePath);
    const config = {
      models: { default: [OUTBOUND_IDENTITY], max_tokens: { analyst: 200 } },
      providers: { ghu_provider: { models: [OUTBOUND_IDENTITY], apiKey: '${PROVIDER_KEY}' } },
      compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'ghu_provider', account: null, model: OUTBOUND_IDENTITY } },
      card_processes: DEFAULT_CARD_PROCESSES,
      mcpServers: { rt_server: { transport: 'stdio', command: 'node', env: { ORDINARY: '${MCP_VALUE}' } } },
    };
    const authority = createTestConfigAuthority(root, {
      relativePath,
      config,
      environment: { PROVIDER_KEY: OUTBOUND_RAW_MARKER, MCP_VALUE: OUTBOUND_RAW_MARKER },
    });
    const source = readFileSync(selectedPath, 'utf8');
    symlinkSync(relativePath, join(root, 'selected-alias'));
    const service = new WorkspaceFileReadModelService(root, records, authority);

    for (const path of [relativePath, 'selected-alias']) {
      const result = service.readFileContent(path);
      expect(result.body).toEqual(expect.objectContaining({
        path,
        size: Buffer.byteLength(source),
        contentType: 'application/json',
        redacted: true,
        sensitivity: 'sensitive-redacted',
      }));
      if (!('content' in result.body) || typeof result.body.content !== 'string') throw new Error('Selected config response is missing content.');
      const projected = JSON.parse(result.body.content) as SaivageConfig;
      expect(projected.models.default).toEqual([OUTBOUND_IDENTITY]);
      expect(projected.providers.ghu_provider.apiKey).toBe('[REDACTED]');
      expect(projected.mcpServers?.rt_server).toEqual(expect.objectContaining({ env: { ORDINARY: '[REDACTED]' } }));
      expect(result.body.content).not.toContain('provider-secret');
      expect(result.body.content).not.toContain('mcp-secret');
      expect(result.body.content).not.toContain(OUTBOUND_RAW_MARKER);
    }
    expect(readFileSync(selectedPath, 'utf8')).toBe(source);
  }));

  it('projects a selected config addressed through work URL before generic work text handling', () => withRoot((root) => {
    const authority = createTestConfigAuthority(root, {
      relativePath: '.saivage/work/tmp/selected.yaml',
      config: {
        models: { default: ['tok_primary'], max_tokens: { analyst: 200 } },
        providers: { provider: { models: ['tok_primary'], apiKey: 'selected-secret' } },
        compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'provider', account: null, model: 'tok_primary' } },
        card_processes: DEFAULT_CARD_PROCESSES,
      },
    });
    const service = new WorkspaceFileReadModelService(root, records, authority);

    const result = service.readFileContent('work:///tmp/selected.yaml');
    expect(result.body).toEqual(expect.objectContaining({ path: 'work:///tmp/selected.yaml', contentType: 'application/json', redacted: true, sensitivity: 'sensitive-redacted' }));
    if (!('content' in result.body) || typeof result.body.content !== 'string') throw new Error('Selected work config response is missing content.');
    expect(JSON.parse(result.body.content)).toEqual(expect.objectContaining({
      models: expect.objectContaining({ default: ['tok_primary'] }),
      providers: expect.objectContaining({ provider: expect.objectContaining({ apiKey: '[REDACTED]' }) }),
    }));
    expect(result.body.content).not.toContain('selected-secret');
  }));

  it('retains binary rejection for ordinary and selected work files', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work/tmp'), { recursive: true });
    writeFileSync(join(root, '.saivage/work/tmp/binary.bin'), Buffer.from([0, 1, 2, 3]));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('work:///tmp/binary.bin')).toEqual({
      statusCode: 415,
      body: { error: 'Binary or non-text file cannot be previewed.', path: 'work:///tmp/binary.bin' },
    });

    const selectedAuthority = createTestConfigAuthority(root, { relativePath: '.saivage/work/tmp/selected-binary.bin' });
    writeFileSync(selectedAuthority.path, Buffer.from([0, 1, 2, 3]));
    const selectedService = new WorkspaceFileReadModelService(root, records, selectedAuthority);
    expect(selectedService.readFileContent('work:///tmp/selected-binary.bin')).toEqual({
      statusCode: 415,
      body: { error: 'Binary or non-text file cannot be previewed.', path: 'work:///tmp/selected-binary.bin' },
    });
  }));

  it('lists work directories with work URL child paths while preserving project-relative navigation', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes', 'proc-1'), { recursive: true });
    writeFileSync(join(root, '.saivage/work', 'processes', 'proc-1', 'stdout.log'), 'stdout output', 'utf8');
    writeFileSync(join(root, 'README.md'), 'readme', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('work:///processes/proc-1')).toEqual(expect.objectContaining({ body: expect.objectContaining({ files: [expect.objectContaining({ path: 'work:///processes/proc-1/stdout.log' })] }) }));
    expect(service.readFileContent('README.md')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'README.md', content: 'readme' }) }));
    expect(service.readFileContent('work:///processes/proc-1/missing.log').statusCode).toBe(404);
  }));

  it('lists the canonical work root and treats it as a directory for content reads', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work', 'processes'), { recursive: true });
    mkdirSync(join(root, '.saivage/work', 'tmp'), { recursive: true });
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('work:///')).toEqual({
      body: {
        path: 'work:///',
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'processes', path: 'work:///processes', type: 'directory' }),
          expect.objectContaining({ name: 'tmp', path: 'work:///tmp', type: 'directory' }),
        ]),
      },
    });
    expect(service.readFileContent('work:///')).toEqual({ statusCode: 400, body: { error: 'Path is a directory', path: 'work:///' } });
  }));
});

describe('WorkspaceFileReadModelService record URLs', () => {
  it('validates the complete URL before reading and maps only typed absence to fixed 404', () => withRoot((root) => {
    const record = jest.fn(() => { throw new AuthoredRecordNotFoundError(); });
    const service = new WorkspaceFileReadModelService(root, () => ({ ...records(), record }), createTestConfigAuthority(root));
    for (const path of [
      'record:///bogus.md?card=project&v=latest',
      'record:///card.json?card=project&v=latest',
      'record:///brief.md?card=project&v=latest&extra=x',
      'record:///brief.md?card=project&card=project&v=latest',
      'record:///brief.md?card=INVALID&v=latest',
      'record:///brief.md?card=project&v=open',
      'record:///brief.md?card=project&v=1e0',
      'record:///brief.md?card=project&v=latest#fragment',
    ]) expect(service.readFileContent(path).statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();
    expect(service.readFileContent('record:///brief.md?card=project&v=latest')).toEqual({ statusCode: 404, body: { error: 'Closed record not found.', path: 'record:///brief.md?card=project&v=latest' } });
  }));

  it('propagates hostile non-absence reader failures unchanged', () => withRoot((root) => {
    const hostile = Object.assign(new Error('HOSTILE_RECORD_FAILURE'), { token: 'HOSTILE_TOKEN' });
    const service = new WorkspaceFileReadModelService(root, () => ({ ...records(), record: () => { throw hostile; } }), createTestConfigAuthority(root));
    expect(() => service.readFileContent('record:///brief.md?card=project&v=latest')).toThrow(hostile);
  }));
});

describe('WorkspaceFileReadModelService security admission', () => {
  it('reserves canonical card paths and every normalized lexical equivalent without physical fallback', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/cards/project'), { recursive: true });
    writeFileSync(join(root, '.saivage/cards/project', 'unlinked.txt'), 'must stay opaque', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    for (const path of [
      '.saivage/cards',
      '.saivage/cards/project',
      './.saivage/cards/project',
      '.saivage//cards/project',
      '.saivage/cards/project/',
      '.saivage/./cards/project',
      join(root, '.saivage/cards/project'),
    ]) {
      expect(service.listFiles(path).statusCode).toBe(404);
    }
    expect(service.readFileContent('.saivage/cards/project/unlinked.txt').statusCode).toBe(404);
  }));

  it('treats POSIX backslashes as ordinary filename characters rather than card grammar separators', () => withRoot((root) => {
    const ordinaryName = '.saivage\\cards';
    writeFileSync(join(root, ordinaryName), 'ordinary backslash filename', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent(ordinaryName)).toEqual(expect.objectContaining({
      body: expect.objectContaining({ path: ordinaryName, content: 'ordinary backslash filename' }),
    }));
    expect(service.listFiles('.').body).toEqual(expect.objectContaining({
      files: expect.arrayContaining([expect.objectContaining({ name: ordinaryName, path: ordinaryName })]),
    }));
  }));

  it('makes project and work aliases into card storage opaque while preserving ordinary aliases', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/cards/project'), { recursive: true });
    mkdirSync(join(root, '.saivage/work/processes/proc-1'), { recursive: true });
    writeFileSync(join(root, '.saivage/cards/project/card.jsonl'), 'malformed physical nonmember', 'utf8');
    writeFileSync(join(root, 'ordinary.txt'), 'ordinary', 'utf8');
    symlinkSync('.saivage/cards/project/card.jsonl', join(root, 'card-alias'));
    symlinkSync('../../cards/project/card.jsonl', join(root, '.saivage/work', 'card-alias'));
    symlinkSync('ordinary.txt', join(root, 'ordinary-alias'));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('card-alias').statusCode).toBe(404);
    expect(service.readFileContent('work:///card-alias').statusCode).toBe(404);
    expect(listedNames(service.listFiles('.').body)).not.toContain('card-alias');
    expect(listedNames(service.listFiles('work:///').body)).not.toContain('card-alias');
    expect(service.readFileContent('ordinary-alias')).toEqual(expect.objectContaining({ body: expect.objectContaining({ content: 'ordinary' }) }));
  }));

  it('reserves relative, absolute, and outside-then-reentering link chains into cards', () => {
    const outside = mkdtempSync(join(tmpdir(), 'saivage-workspace-chain-outside-'));
    try {
      withRoot((root) => {
        mkdirSync(join(root, '.saivage/cards/project'), { recursive: true });
        mkdirSync(join(root, 'links'), { recursive: true });
        symlinkSync('../.saivage/cards', join(root, 'links', 'relative'));
        symlinkSync(join(root, '.saivage/cards'), join(root, 'absolute'));
        symlinkSync(outside, join(root, 'leave'));
        symlinkSync(join(root, '.saivage/cards'), join(outside, 'reenter'));
        const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

        expect(service.listFiles('links/relative/project').statusCode).toBe(404);
        expect(service.listFiles('absolute/project').statusCode).toBe(404);
        expect(service.listFiles('leave/reenter/project').statusCode).toBe(404);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails cyclic aliases closed and leaves broken aliases to generic missing-path behavior', () => withRoot((root) => {
    symlinkSync('cycle-b', join(root, 'cycle-a'));
    symlinkSync('cycle-a', join(root, 'cycle-b'));
    symlinkSync('missing-target', join(root, 'broken'));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('cycle-a').statusCode).toBe(403);
    expect(service.readFileContent('broken').statusCode).toBe(404);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['cycle-a', 'cycle-b', 'broken']));
  }));

  it('rejects malformed work URLs before alias handling and retains canonical work spelling', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/work'), { recursive: true });
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    for (const path of ['work:////', 'work:///double//segment', 'work:///trailing/', 'work:///segment?query=1', 'work:///segment#fragment', 'work:///foo..bar']) {
      expect(service.listFiles(path).statusCode).toBe(403);
    }
    expect(service.listFiles('work:///')).toEqual(expect.objectContaining({ body: expect.objectContaining({ path: 'work:///' }) }));
  }));

  it('rejects direct blocked paths, including exact and nonexistent lock namespaces', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/locks'), { recursive: true });
    writeFileSync(join(root, '.saivage/locks/runtime.lock'), 'synthetic lock', 'utf8');
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('.saivage/locks').statusCode).toBe(403);
    expect(service.readFileContent('.saivage/locks').statusCode).toBe(403);
    expect(service.readFileContent('.saivage/locks/not-created.lock').statusCode).toBe(403);
    expect(service.readFileContent('.env').statusCode).toBe(403);
  }));

  it('omits blocked children and aliases while retaining redacted files and aliases', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage/locks'), { recursive: true });
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    writeFileSync(join(root, '.saivage/saivage.yaml'), 'apiKey: synthetic-redaction-value\nname: visible-name\n', 'utf8');
    writeFileSync(join(root, 'README.md'), 'ordinary', 'utf8');
    symlinkSync('.env', join(root, 'safe-file-alias'));
    symlinkSync('.saivage/locks', join(root, 'safe-directory-alias'));
    symlinkSync('.saivage/saivage.yaml', join(root, 'safe-redacted-alias'));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    const listing = service.listFiles('.');
    expect(listing.body).toEqual(expect.objectContaining({
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'README.md' }),
        expect.objectContaining({ name: 'safe-redacted-alias' }),
      ]),
    }));
    const names = listedNames(listing.body);
    expect(names).not.toContain('.env');
    expect(names).not.toContain('safe-file-alias');
    expect(names).not.toContain('safe-directory-alias');
    expect(service.readFileContent('safe-file-alias').statusCode).toBe(403);
    expect(service.listFiles('safe-directory-alias').statusCode).toBe(403);

    for (const path of ['.saivage/saivage.yaml', 'safe-redacted-alias']) {
      const result = service.readFileContent(path);
      expect(result).toEqual(expect.objectContaining({ body: expect.objectContaining({ path, redacted: true, sensitivity: 'sensitive-redacted' }) }));
      if ('content' in result.body) {
        expect(result.body.content).not.toContain('synthetic-redaction-value');
        expect(result.body.content).toContain('visible-name');
      }
    }
  }));

  it('gives blocking precedence when the lexical redacted path targets a blocked file', () => withRoot((root) => {
    mkdirSync(join(root, '.saivage'), { recursive: true });
    writeFileSync(join(root, '.env'), 'synthetic blocked value', 'utf8');
    symlinkSync('../.env', join(root, '.saivage/saivage.yaml'));
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('.saivage/saivage.yaml').statusCode).toBe(403);
  }));

  it('rejects file and directory aliases whose targets are outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'saivage-workspace-outside-'));
    try {
      withRoot((root) => {
        writeFileSync(join(outside, 'outside.txt'), 'outside synthetic value', 'utf8');
        mkdirSync(join(outside, 'directory'));
        symlinkSync(join(outside, 'outside.txt'), join(root, 'outside-file-alias'));
        symlinkSync(join(outside, 'directory'), join(root, 'outside-directory-alias'));
        const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

        expect(service.readFileContent('outside-file-alias').statusCode).toBe(403);
        expect(service.listFiles('outside-directory-alias').statusCode).toBe(403);
        const listing = service.listFiles('.');
        const names = listedNames(listing.body);
        expect(names).not.toContain('outside-file-alias');
        expect(names).not.toContain('outside-directory-alias');
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceFileReadModelService canonical card files', () => {
  it('projects the synthetic parent row and traverses active linked virtual directories', () => withRoot((root) => {
    initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const service = new WorkspaceFileReadModelService(root, () => cardFilesReader(cards), createTestConfigAuthority(root));
    const project = cards.read('project')!;

    expect(service.listFiles('.saivage').body).toEqual(expect.objectContaining({ files: expect.arrayContaining([
      { name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: project.updated_at },
    ]) }));
    expect(service.listFiles('.saivage/cards')).toEqual({ body: { path: '.saivage/cards', files: [
      { name: 'project', path: '.saivage/cards/project', type: 'directory', modifiedAt: project.updated_at },
    ] } });
    expect(service.listFiles('.saivage/cards/project').body).toEqual(expect.objectContaining({ files: expect.arrayContaining([
      { name: 'children', path: '.saivage/cards/project/children', type: 'directory', modifiedAt: project.updated_at },
      expect.objectContaining({ name: 'card.jsonl', type: 'file' }),
      expect.objectContaining({ name: 'brief.jsonl', type: 'file' }),
    ]) }));
    expect(service.listFiles('.saivage/cards/project/children')).toEqual({ body: { path: '.saivage/cards/project/children', files: [
      { name: 'a', path: '.saivage/cards/project/children/a', type: 'directory', modifiedAt: child.updated_at },
    ] } });
    expect(service.listFiles('.saivage/cards/project/children/a/children')).toEqual({ body: { path: '.saivage/cards/project/children/a/children', files: [] } });
  }));

  it('lists fixed slots from descriptor metadata and validates only explicitly requested content', () => withRoot((root) => {
    initProjectTree(root);
    const cards = new CardService(root);
    const statusPath = join(cardNamespace(root, 'project'), 'status.jsonl');
    const reviewPath = join(cardNamespace(root, 'project'), 'review.jsonl');
    writeFileSync(statusPath, 'complete but malformed\n', 'utf8');
    writeFileSync(reviewPath, 'unterminated optional suffix', 'utf8');
    const service = new WorkspaceFileReadModelService(root, () => cardFilesReader(cards), createTestConfigAuthority(root));

    const cardFiles = service.listFiles('.saivage/cards/project');
    expect(listedNames(cardFiles.body)).toEqual(['children', 'card.jsonl', 'brief.jsonl', 'status.jsonl', 'review.jsonl']);
    expect(cardFiles.body).toEqual(expect.objectContaining({ files: expect.arrayContaining([
      expect.objectContaining({ name: 'card.jsonl', path: '.saivage/cards/project/card.jsonl', type: 'file', size: expect.any(Number), modifiedAt: expect.any(String) }),
    ]) }));
    expect(readFileSync(reviewPath, 'utf8')).toBe('unterminated optional suffix');
    expect(() => service.readFileContent('.saivage/cards/project/status.jsonl')).toThrow(/malformed/);
    expect(service.readFileContent('.saivage/cards/project/card.jsonl')).toEqual(expect.objectContaining({ body: expect.objectContaining({
      path: '.saivage/cards/project/card.jsonl',
      contentType: 'text/plain',
      redacted: false,
      modifiedAt: expect.any(String),
    }) }));
    expect(() => service.readFileContent('.saivage/cards/project/review.jsonl')).toThrow(/is empty/);
    expect(readFileSync(reviewPath, 'utf8')).toBe('');
  }));
});
