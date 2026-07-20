import type { CardPatch, SetStatusTarget, TerminalLifecycleCommit } from '../../src/cards/card-api.js';

const ordinary = { title: 'updated', priority: 1, status_text: null } satisfies CardPatch;
void ordinary;

// @ts-expect-error lifecycle is private to dedicated lifecycle operations
({ lifecycle: { status: 'running', result: null, error: null, completed_at: null } } satisfies CardPatch);
// @ts-expect-error identity is not ordinary mutable state
({ id: 'card-a' } satisfies CardPatch);
// @ts-expect-error type is immutable
({ type: 'code' } satisfies CardPatch);
// @ts-expect-error children are parent-owned
({ children: [] } satisfies CardPatch);
// @ts-expect-error top-level card status does not exist
({ status: 'running' } satisfies CardPatch);
// @ts-expect-error parent is identity-derived
({ parent: 'project' } satisfies CardPatch);
// @ts-expect-error depth is identity-derived
({ depth: 1 } satisfies CardPatch);
// @ts-expect-error publication owns version sequence
({ version_seq: 2 } satisfies CardPatch);
// @ts-expect-error operator actions are projection-only
({ allowedActions: [] } satisfies CardPatch);

const running = 'running' satisfies SetStatusTarget;
void running;
// @ts-expect-error STOPPED has its own recovery operation
('stopped' satisfies SetStatusTarget);
// @ts-expect-error done requires a terminal commit
('done' satisfies SetStatusTarget);
// @ts-expect-error failed requires a terminal commit
('failed' satisfies SetStatusTarget);

const done = { lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-20T00:00:00.000Z' } } satisfies TerminalLifecycleCommit;
const failed = { lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-20T00:00:00.000Z' } } satisfies TerminalLifecycleCommit;
const blocked = { lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'blocked' }, error: 'blocked', completed_at: null } } satisfies TerminalLifecycleCommit;
void [done, failed, blocked];
// @ts-expect-error nonterminal lifecycle is not a terminal commit
({ lifecycle: { status: 'running', result: null, error: null, completed_at: null } } satisfies TerminalLifecycleCommit);
