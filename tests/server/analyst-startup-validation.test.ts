import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfiguredAnalystConversation } from '../../src/application/analyst-startup-validation.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { globalAgentConversationVersionFile } from '../../src/persistence/layout.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const SESSION = 'agent:analyst:global' as const;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('configured Analyst runtime validation', () => {
  it('accepts a configured empty catalog without publication', () => {
    const root = projectRoot();
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
    validateConfiguredAnalystConversation(root, SESSION);
    expect(readCurrentConversationSegment(root, SESSION)).toBeNull();
  });

  it('byte-preserves valid current conversation data', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'workspace', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); const before = readFileSync(path);
    validateConfiguredAnalystConversation(root, SESSION);
    expect(readFileSync(path)).toEqual(before);
  });

  it('does not repair a malformed runtime suffix', () => {
    const root = projectRoot(); appendConversationBatch({ projectRoot: root }, buildAnalystIngressRows(SESSION, '11111111-1111-4111-8111-111111111111', 'workspace', 'question'));
    const segment = readCurrentConversationSegment(root, SESSION)!; const path = globalAgentConversationVersionFile(root, 'analyst', segment.entry.filename); appendFileSync(path, '{"broken":'); const before = readFileSync(path);
    expect(() => validateConfiguredAnalystConversation(root, SESSION)).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(before);
  });
});

function projectRoot(): string { const root = mkdtempSync(join(tmpdir(), 'analyst-startup-validation-')); roots.push(root); initProjectTree(root); return root; }
