import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { Environment } from '../../src/config/index.js';
import { saivageCardsRoot as realSaivageCardsRoot } from '../../src/persistence/layout.js';

type Event =
  | { readonly kind: 'mkdir'; readonly path: string; readonly options: { readonly recursive: true } }
  | { readonly kind: 'publish'; readonly projectRoot: string; readonly input: unknown; readonly workflow: unknown }
  | { readonly kind: 'conversation'; readonly projectRoot: string; readonly sessionId: string };

const events: Event[] = [];
const roots: string[] = [];

const mkdirSync = jest.fn((path: realFs.PathLike, options?: realFs.MakeDirectoryOptions) => {
  events.push({ kind: 'mkdir', path: String(path), options: options as { recursive: true } });
  return realFs.mkdirSync(path, options);
}) as unknown as typeof realFs.mkdirSync;

jest.unstable_mockModule('node:fs', () => ({ ...realFs, mkdirSync }));
jest.unstable_mockModule('../../src/persistence/card-files.js', () => ({
  publishInitialProjectCard: (projectRoot: string, input: unknown, workflow: unknown) => {
    events.push({ kind: 'publish', projectRoot, input, workflow });
  },
}));
jest.unstable_mockModule('../../src/persistence/conversation-file.js', () => ({
  initializeConversation: (projectRoot: string, sessionId: string) => {
    events.push({ kind: 'conversation', projectRoot, sessionId });
  },
}));
jest.unstable_mockModule('../../src/persistence/layout.js', () => ({
  saivageCardsRoot: realSaivageCardsRoot,
}));
jest.unstable_mockModule('../../src/schemas/index.js', () => ({
  globalAgentSessionId: (name: string) => `agent:${name}:global`,
}));

const { publishInitialProjectRuntime } = await import('../../src/boot/project-runtime-bootstrap.js');

afterEach(() => {
  events.length = 0;
  while (roots.length > 0) realFs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('initial project runtime publication', () => {
  it('creates the cards root, publishes the project card, then initializes the Analyst conversation', () => {
    const projectRoot = realFs.mkdtempSync(join(tmpdir(), 'saivage-project-bootstrap-'));
    roots.push(projectRoot);
    const projectWorkflow = Object.freeze({ cardType: 'project' });
    const workflows = {
      cardTypes: new Map([['project', projectWorkflow]]),
      analyst: { name: 'analyst' },
    } as unknown as Environment['workflows'];
    const title = basename(projectRoot);

    publishInitialProjectRuntime(projectRoot, workflows);

    expect(events).toEqual([
      { kind: 'mkdir', path: realSaivageCardsRoot(projectRoot), options: { recursive: true } },
      {
        kind: 'publish',
        projectRoot,
        input: {
          title,
          bootstrap_content: `# Goal\n\nDefine and execute the ${title} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card bootstrap record.\n- Child work is created under this project card.\n`,
        },
        workflow: projectWorkflow,
      },
      { kind: 'conversation', projectRoot, sessionId: 'agent:analyst:global' },
    ]);
  });
});
