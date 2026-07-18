import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

import { publishInitialProjectCard as publishCanonicalProjectCard } from '../../src/persistence/card-files.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { acquireRuntimeLifecycleLock, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';
import type { CardRecord } from '../../src/schemas/index.js';

const readProjectCardOrAssertInitialPublicationAllowed = jest.fn<(...args: any[]) => any>();
const publishInitialProjectCard = jest.fn<(...args: any[]) => any>();
const startServer = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../../src/persistence/card-files.js', () => ({ publishInitialProjectCard }));
jest.unstable_mockModule('../../src/persistence/generated-state.js', () => ({ readProjectCardOrAssertInitialPublicationAllowed }));
jest.unstable_mockModule('../../src/server/server.js', () => ({ startServer }));

const { startApp } = await import('../../src/boot/app.js');

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-startup-config-'));
  roots.push(root);
  createProjectIdentity(root, 'startup-config-test');
  return root;
}

function writeConfig(root: string, analystMaxTokens: number): void {
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify({
    models: { default: ['test-model'], max_tokens: { analyst: analystMaxTokens } },
    providers: { test: { models: ['test-model'] } },
    compaction: {
      enabled: true,
      input_budget_tokens: 1000,
      summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
    },
    runtime: { continuous_improvement: false },
    server: { host: '127.0.0.1', port: 8080 },
  }));
}

function argv(root: string): string[] {
  return ['node', 'test', 'start', '--project-root', root, '--create-runtime'];
}

function publishExistingRootCard(root: string): void {
  const stamp = '2026-07-17T00:00:00.000Z';
  const card: CardRecord = {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, children: [], title: 'existing', status: 'backlog', subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, pending_notifications: [], version_seq: 1,
  };
  mkdirSync(join(root, '.saivage', 'cards'));
  publishCanonicalProjectCard(root, card, '# Existing root\n', 'analyst');
}

describe('startup configuration validation before runtime publication', () => {
  beforeEach(() => {
    readProjectCardOrAssertInitialPublicationAllowed.mockReset().mockReturnValue(null);
    publishInitialProjectCard.mockReset();
    startServer.mockReset().mockResolvedValue({ fastify: { server: { address: () => ({ port: 43210 }) } } });
  });

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('releases the real lock and leaves initially absent card state absent when config is one token over reserve', async () => {
    const root = projectRoot();
    writeConfig(root, 201);

    await expect(startApp({ argv: argv(root), env: {} })).rejects.toThrow(
      'Effective Analyst max tokens 201 (source: analyst) exceed reserved completion tokens 200 (floor(input_budget_tokens 1000 * completion_reserve_fraction 0.2)). Raise compaction.input_budget_tokens or compaction.completion_reserve_fraction, or lower the configured Analyst max.',
    );

    const handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    releaseRuntimeLifecycleLock(handle);
    expect(readProjectCardOrAssertInitialPublicationAllowed).not.toHaveBeenCalled();
    expect(publishInitialProjectCard).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.saivage', 'cards'))).toBe(false);
    expect(existsSync(join(root, '.saivage', 'cards', 'project', 'card.jsonl'))).toBe(false);
    expect(existsSync(join(root, '.saivage', 'cards', 'project', 'brief.jsonl'))).toBe(false);
  });

  it('leaves pre-existing exact root-card artifacts byte-for-byte unchanged', async () => {
    const root = projectRoot();
    writeConfig(root, 201);
    const cardPath = join(root, '.saivage', 'cards', 'project', 'card.jsonl');
    const briefPath = join(root, '.saivage', 'cards', 'project', 'brief.jsonl');
    publishExistingRootCard(root);
    const cardBytes = readFileSync(cardPath);
    const briefBytes = readFileSync(briefPath);

    await expect(startApp({ argv: argv(root), env: {} })).rejects.toThrow('Effective Analyst max tokens 201');

    expect(readProjectCardOrAssertInitialPublicationAllowed).not.toHaveBeenCalled();
    expect(publishInitialProjectCard).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(readFileSync(cardPath)).toEqual(cardBytes);
    expect(readFileSync(briefPath)).toEqual(briefBytes);
  });

  it('publishes the initial project card after exact-fit config validation', async () => {
    const root = projectRoot();
    writeConfig(root, 200);

    const app = await startApp({ argv: argv(root), env: {} });
    try {
      expect(readProjectCardOrAssertInitialPublicationAllowed).toHaveBeenCalledWith(root);
      expect(publishInitialProjectCard).toHaveBeenCalledTimes(1);
      expect(startServer).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop();
    }
  });

  it('skips initial publication when the bootstrap decision returns an existing card', async () => {
    const root = projectRoot();
    writeConfig(root, 200);
    readProjectCardOrAssertInitialPublicationAllowed.mockReturnValue({ id: 'project' });

    const app = await startApp({ argv: argv(root), env: {} });
    try {
      expect(readProjectCardOrAssertInitialPublicationAllowed).toHaveBeenCalledWith(root);
      expect(publishInitialProjectCard).not.toHaveBeenCalled();
      expect(startServer).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop();
    }
  });

  it('does not start the server and releases the real lock when the bootstrap decision fails', async () => {
    const root = projectRoot();
    writeConfig(root, 200);
    readProjectCardOrAssertInitialPublicationAllowed.mockImplementation(() => { throw new Error('partial generated state'); });

    await expect(startApp({ argv: argv(root), env: {} })).rejects.toThrow('partial generated state');

    expect(publishInitialProjectCard).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    const handle = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    releaseRuntimeLifecycleLock(handle);
  });
});
