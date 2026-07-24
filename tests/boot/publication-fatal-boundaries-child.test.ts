import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';
import { readRuntimeLockStatus } from '../../src/runtime/lock.js';

const roots: string[] = [];
const fixture = join(process.cwd(), 'tests', 'fixtures', 'publication-fatal-boundaries.ts');
const diagnostic = 'Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.\n';
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function child(mode: string, value?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', fixture, mode, ...(value ? [value] : [])], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
}

function expectFatalOwner(mode: string): void {
  const root = mkdtempSync(join(tmpdir(), `publication-${mode}-`)); roots.push(root);
  const marker = join(root, 'marker'); writeFileSync(marker, '');
  const result = child(mode, marker);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(diagnostic);
  expect(readFileSync(marker, 'utf8')).toBe('entered');
}

describe('publication fatal owner boundaries', () => {
  it('exits from BaseActor task delivery before failed-task or actor-main effects', () => {
    const result = child('base-actor-task');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(diagnostic);
  });

  it('exits direct mutation without releasing the lifecycle lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'publication-direct-mutation-')); roots.push(root);
    createProjectIdentity(root, 'Fatal boundary');
    const result = child('direct-mutation', root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(diagnostic);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
    expect(readRuntimeLockStatus(root).kind).toBe('dead');
    unlinkSync(runtimeProcessLockFile(root));
  });

  it('exits the WebSocket queue owner before a frame or second turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'publication-websocket-')); roots.push(root);
    const marker = join(root, 'marker'); writeFileSync(marker, '');
    const result = child('websocket', marker);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(diagnostic);
    expect(readFileSync(marker, 'utf8')).toBe('1');
  });

  it('exits nested ConversationLLMActor ownership before terminal settlement', () => {
    expectFatalOwner('llm-conversation');
  });

  it('exits ProcessRunner chunk ownership before another chunk or terminal settlement', () => {
    expectFatalOwner('process-chunk');
  });

  it('exits process-placeholder replacement ownership before launch', () => {
    expectFatalOwner('process-placeholder');
  });

  it('exits work replacement ownership before tool success', () => {
    expectFatalOwner('work-replacement');
  });

  it('exits auth/provider projection replacement ownership before retry or projection', () => {
    expectFatalOwner('auth-projection');
  });

  it('exits ContractRuntime before logging or sending HTTP 500', () => {
    expectFatalOwner('contract-runtime');
  });

  it.each(['analyst-card', 'analyst-config', 'analyst-app-log'] as const)('exits Analyst WebSocket ownership after %s publication without a response or follow-up', (mode) => {
    expectFatalOwner(mode);
  });
});
