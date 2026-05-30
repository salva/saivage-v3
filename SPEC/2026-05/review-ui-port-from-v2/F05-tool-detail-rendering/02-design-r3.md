# F05 — Tool detail rendering: Design (R3)

Writer round 3 for [02-design-r2.md](02-design-r2.md). Binding
critique: [02-design-review-r2.md](02-design-review-r2.md).
Approved analysis: [01-analysis-r2.md](01-analysis-r2.md) /
[ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md).

Companion approved analyses / designs (binding):
[F02 r2](../F02-component-hierarchy/02-design-r2.md),
[F03 r2 design](../F03-conversation-rounds/02-design-r2.md),
[F04 r2 design](../F04-chat-surface-style/02-design-r2.md).

Verified v3 source paths (relative to this file):
[../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts),
[../../../../web/src/stores/files.ts](../../../../web/src/stores/files.ts),
[../../../../web/src/views/FilesView.vue](../../../../web/src/views/FilesView.vue),
[../../../../web/src/components/agents/AgentConversationView.vue](../../../../web/src/components/agents/AgentConversationView.vue),
[../../../../web/src/components/chat/AnalystChatPanel.vue](../../../../web/src/components/chat/AnalystChatPanel.vue).

**Project rule (binding): architecture-first, NO backward
compatibility.** No alias subsystem, no `string | InlinePart[]`
shim, no `FormattedToolPair`, no `root: 'project'`, no parallel
public surface, no transitional `callContentRaw` / `resultContentRaw`
field names. Every replaced helper/type/template/route field is
removed in the same commit set as its replacement.

---

## 0. Coverage map (r2 review → r3)

| # | Reviewer-required item ([02-design-review-r2.md](02-design-review-r2.md)) | Addressed in |
| - | -------------------------------------------------------------------------- | ------------ |
| 1 | **Blocking — cross-document chip contract alignment.** F02 r2 §1.3.14 and §3 still publish a six-prop `ToolChip` API and use the names `callContentRaw` / `resultContentRaw`, which do not exist in F03 r2, F04 r2, or F05. r3 (a) re-publishes the canonical eight-prop bag as F05's binding contract, (b) declares F02 r2's six-prop snippets and `*Raw` field names as superseded errata that must be brought in line at F02 r3 / implementation time, (c) names the offending F02 sites by line range so the F02 writer has nothing to find. | [§1.2](#12-public-presenter-contract-unchanged), [§4.1](#41-toolchip-prop-bag-canonical-eight-prop-binding), [§4.4](#44-cross-document-errata-binding) |
| 2 | **Non-blocking — source links use the wrong relative depth.** From this file, repo-root `web/` is reached with four `..` segments, not three. r3 fixes every source citation accordingly. | front-matter, [§3.5](#35-per-tool-coverage-table), [§4.3](#43-filesview-routing-unchanged-from-r2), [§5.2](#52-deletions-landed-in-the-same-change-set) |
| 3 | **Non-blocking — `sideEffects` path wording.** The r2 coverage-map prose said `./web/src/utils/tool-presenters/**` while the actual `web/package.json` snippet used `src/utils/tool-presenters/**/*.ts`. r3 standardises on the package-relative form (`src/utils/tool-presenters/**/*.ts`) everywhere. | [§3.4](#34-initialization-contract-and-tree-shake-rule) |

Items audited PASS by the r2 review and carried forward unchanged:

| r1 item | r2 status (reviewer) | r3 carry-forward |
| ------- | -------------------- | ----------------- |
| 1. Drop `registerAlias` / `ALIASES`; shared factories instead. | PASS | [§3.1](#31-registry-and-types), [§3.2](#32-shared-factories-replace-aliases), [§3.3](#33-per-tool-files-with-shared-factories) |
| 2. Raw-content ownership lives on the chip prop bag, not on the presentations. | PASS (F05 side) | [§1.2](#12-public-presenter-contract-unchanged), [§4.1](#41-toolchip-prop-bag-canonical-eight-prop-binding), [§4.2](#42-formattedcontent-and-jsonview-stay-content-owned) |
| 3. Single canonical public import path; delete the old file. | PASS | [§3.1](#31-registry-and-types), [§5](#5-canonical-import-paths-and-file-deletions) |
| 4. Registry initialization / tree-shake story closed. | PASS | [§3.4](#34-initialization-contract-and-tree-shake-rule), [§6.5](#65-registry-and-barrel-integrity-tests) |
| 5. Per-tool matrix reconciled (process pid, not stdout-tail). | PASS | [§3.5](#35-per-tool-coverage-table), [§6.5](#65-registry-and-barrel-integrity-tests) |
| 6. Browser-facing seam tests. | PASS | [§6.1–§6.7](#6-test-plan) |

Strengths from r1/r2 retained (cross-referenced): Proposal B
selected ([§2](#2-recommendation-recap)); `InlinePart` union,
`json-tokenize`, `JsonView`, `FormattedContent` shapes
([§4](#4-chip-integration-and-content-components)); status-derivation
rules ([§3.1](#31-registry-and-types)); non-button
`<div role="group">` with sibling links
([§4.1](#41-toolchip-prop-bag-canonical-eight-prop-binding));
1 MB `JsonView` raw fallback
([§4.2](#42-formattedcontent-and-jsonview-stay-content-owned)).

---

## 1. Scope and contracts

### 1.1 Inputs (unchanged)

- F05 analysis r2 [§2](01-analysis-r2.md#2-presenter-contract-independent-no-hidden-pair-state):
  `presentToolCall(rawContent, fallbackName?)` and
  `presentToolResult(rawContent, { tool?, kind? })` are independent;
  return `{ icon, name, headline: InlinePart[], detail: InlinePart[], status }`.
- F05 analysis r2 [§3](01-analysis-r2.md#3-inlinepart-type-final-exported):
  `InlinePart` is a four-arm union (`text` / `file` / `url` / `code`);
  `file.root: 'meta' | 'output'`.
- F03 r2 design [§7.2](../F03-conversation-rounds/02-design-r2.md):
  `<ToolChip>` carries
  `{ call, result, callContent, resultContent, status, expanded, detailsId, timestamp? }`
  and is the **single** chip renderer used by both the agent surface
  (F03) and the analyst surface (F04).
- F04 r2 design [§4.1](../F04-chat-surface-style/02-design-r2.md):
  binds via `v-bind="adaptChatMessageToToolChip(...)"` /
  `v-bind="adaptPendingInvocationToToolChip(...)"`.

### 1.2 Public presenter contract (unchanged)

```ts
// web/src/utils/tool-presenters/index.ts — public exports
export type {
  InlinePart, ToolStatus,
  ToolCallPresentation, ToolResultPresentation,
} from './types';
export { presentToolCall, presentToolResult } from './registry';
```

```ts
// web/src/utils/tool-presenters/types.ts
export type InlinePart =
  | { kind: 'text'; value: string; tone?: 'ok' | 'warn' | 'danger' | 'muted' }
  | { kind: 'file'; path: string; root: 'meta' | 'output' }
  | { kind: 'url';  url: string }
  | { kind: 'code'; value: string };

export type ToolStatus = 'call' | 'ok' | 'error';

export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];
  status: 'call';
}
export interface ToolResultPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail: InlinePart[];
  status: 'ok' | 'error';
}
```

Per r1 review item 2 (still binding): neither presentation
carries a `rawContent` field. Raw producer payloads flow through
`<ToolChip>` as separate string props (`callContent`,
`resultContent`). Presenters remain pure functions of their own
payload only; no hidden coupling.

Status rules (unchanged from r1 §1.9):

1. `ctx.kind === 'tool_error'` → `status: 'error'`.
2. Else parse payload; `record.ok === false` OR `typeof record.error === 'string'` → `status: 'error'`.
3. Else `status: 'ok'`.

Error path: `headline = [{ kind: 'text', value: oneLine(message, 120), tone: 'danger' }]`,
`detail = []`. Per-tool result presenters are NOT invoked on the
error path.

---

## 2. Recommendation recap

Proposal B (registry of self-registering per-tool files) is the
selected direction, unchanged from r1 §10 / r2 §2. Proposal A is
not redeveloped here; it remains the documented fallback in
[02-design-r1.md](02-design-r1.md#a-proposal-a-single-file).

---

## 3. Registry (Proposal B, fixed)

### 3.1 Registry and types

`web/src/utils/tool-presenters/types.ts` adds the presenter
interfaces alongside the public types:

```ts
// (see §1.2 for the four public types)

export interface CallContext {
  args: Record<string, unknown>;
  rawArgs: unknown;
}
export interface ResultContext {
  status: 'ok' | 'error';
  parsed: unknown;
  record: Record<string, unknown> | null;
  rawContent: string;
}

export interface ToolCallPresenter {
  icon: string;
  call(ctx: CallContext): { headline: InlinePart[]; detail: InlinePart[] };
}
export interface ToolResultPresenter {
  iconOk: string;
  iconErr?: string;                                       // defaults to '⚠'
  result(ctx: ResultContext): { headline: InlinePart[]; detail: InlinePart[] };
}

/**
 * A tool presenter declares BOTH halves. Tools that share behaviour use a
 * shared factory (§3.2) and pass the factory's output to each name's own
 * `registerToolPresenter` call. There is no alias indirection.
 */
export interface ToolPresenter {
  call:   ToolCallPresenter;
  result: ToolResultPresenter;
}
```

`web/src/utils/tool-presenters/registry.ts`:

```ts
import type {
  CallContext, ResultContext, InlinePart,
  ToolCallPresentation, ToolResultPresentation,
  ToolPresenter,
} from './types';
import {
  asRecord, oneLine, readToolCallEnvelope, resolveResultName, safeJsonParse, str,
} from './helpers';

const REGISTRY = new Map<string, ToolPresenter>();
let DEFAULT_PRESENTER: ToolPresenter | null = null;

/** Register call+result presenters for a tool. Idempotent failure: duplicate registration throws. */
export function registerToolPresenter(name: string, presenter: ToolPresenter): void {
  if (REGISTRY.has(name)) {
    throw new Error(`tool-presenters: duplicate registration for "${name}"`);
  }
  REGISTRY.set(name, presenter);
}

/** Register the default fallback presenter. Must be called exactly once. */
export function registerDefaultPresenter(presenter: ToolPresenter): void {
  if (DEFAULT_PRESENTER) {
    throw new Error('tool-presenters: default presenter already registered');
  }
  DEFAULT_PRESENTER = presenter;
}

function resolveOrDefault(name: string): ToolPresenter {
  return REGISTRY.get(name) ?? assertDefault();
}
function assertDefault(): ToolPresenter {
  if (!DEFAULT_PRESENTER) {
    throw new Error('tool-presenters: default presenter not registered (import "../../utils/tool-presenters" — the barrel — instead of "./registry" directly)');
  }
  return DEFAULT_PRESENTER;
}

/** Test-only enumerator. Imported ONLY from files under `web/src/__tests__/`. */
export function _registryKeysForTest(): string[] {
  return [...REGISTRY.keys()];
}
/** Test-only enumerator. Imported ONLY from files under `web/src/__tests__/`. */
export function _internalRegistryEntriesForTest(): Array<[string, ToolPresenter]> {
  return [...REGISTRY.entries()];
}

export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation {
  const env = readToolCallEnvelope(rawContent, fallbackName);
  const presenter = resolveOrDefault(env.name);
  const ctx: CallContext = { args: asRecord(env.args) ?? {}, rawArgs: env.args };
  const { headline, detail } = presenter.call.call(ctx);
  return { icon: presenter.call.icon, name: env.name, headline, detail, status: 'call' };
}

export function presentToolResult(
  rawContent: string,
  ctx0: { tool?: string; kind?: 'tool_result' | 'tool_error' } = {},
): ToolResultPresentation {
  const name = resolveResultName(rawContent, ctx0.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  const isError = ctx0.kind === 'tool_error' || record?.ok === false || typeof record?.error === 'string';
  const status: 'ok' | 'error' = isError ? 'error' : 'ok';
  const ctx: ResultContext = { status, parsed, record, rawContent };
  const presenter = resolveOrDefault(name);

  if (status === 'error') {
    const message = str(record?.error ?? record?.message ?? parsed ?? rawContent);
    return {
      icon: presenter.result.iconErr ?? '⚠',
      name, status,
      headline: [{ kind: 'text', value: oneLine(message, 120), tone: 'danger' }],
      detail: [],
    };
  }
  const { headline, detail } = presenter.result.result(ctx);
  return { icon: presenter.result.iconOk, name, headline, detail, status };
}
```

There is no `registerAlias`, no `ALIASES` map, no `aliasNames`
field. The map is keyed by the tool name only.

### 3.2 Shared factories replace aliases

Multiple tool names with identical or near-identical behaviour use
shared **factories** defined in `helpers.ts` (or co-located in the
first per-tool file when only used by one family). Each tool file
calls `registerToolPresenter(name, makeXPresenter(opts))` explicitly.

```ts
// web/src/utils/tool-presenters/helpers.ts (factory excerpts)

export function makeReadFilePresenter(): ToolPresenter {
  return {
    call: {
      icon: '📖',
      call: ({ args }) => ({
        headline: [{ kind: 'text', value: shortPath(str(args.path)) }],
        detail: [],
      }),
    },
    result: {
      iconOk: '↩',
      result: ({ record, rawContent }) => {
        const rec = asRecord(record);
        if (!rec) return { headline: [{ kind: 'text', value: oneLine(rawContent, 96) }], detail: [] };
        if (rec.binary === true) return { headline: [{ kind: 'text', value: 'binary file' }], detail: [] };
        const content = typeof rec.content === 'string' ? rec.content : '';
        const bytes = typeof rec.bytes === 'number' ? rec.bytes : content.length;
        const lines = content ? content.split('\n').length : typeof rec.lines === 'number' ? rec.lines : 0;
        const text = lines ? `${lines} lines · ${formatBytes(bytes)}` : formatBytes(bytes);
        return { headline: [{ kind: 'text', value: text, tone: 'muted' }], detail: [] };
      },
    },
  };
}

export function makeListDirectoryPresenter(): ToolPresenter { /* see §3.3 */ }
export function makeRunCommandPresenter(opts: { icon?: string } = {}): ToolPresenter { /* see §3.3 */ }
export function makeCardOutcomePresenter(verb: 'activated' | 'cancelled' | 'restarted' | 'deleted'): ToolPresenter { /* see §3.3 */ }
export function makeJsonlTailPresenter(label: 'events' | 'errors' | 'control actions'): ToolPresenter { /* see §3.3 */ }
export function makeRuntimeControlPresenter(verb: 'paused' | 'resumed', icon: string): ToolPresenter { /* see §3.3 */ }
export function makeGoalControlPresenter(verb: 'aborted' | 'restarted', icon: string): ToolPresenter { /* see §3.3 */ }
export function makeGoalReportPresenter(verb: 'done' | 'failed' | 'blocked', tone: 'ok' | 'danger' | 'warn'): ToolPresenter { /* see §3.3 */ }
```

The factory pattern preserves Proposal B's "one file per tool"
discipline (each tool's behaviour is anchored to a single
`registerToolPresenter` call in a file named after the tool), and
removes the alias side channel. It also makes "tools that share
behaviour" explicit at the call site — a reader of
`read_file.ts` sees `makeReadFilePresenter()` and knows where to
find the implementation.

### 3.3 Per-tool files with shared factories

Layout:

```
web/src/utils/tool-presenters/
  index.ts                       ← side-effect barrel (only public entrypoint)
  registry.ts                    ← REGISTRY, presentToolCall, presentToolResult, _registryKeysForTest
  types.ts                       ← public types + presenter interfaces
  helpers.ts                     ← asRecord, oneLine, shortPath, formatBytes, argKeys,
                                    readToolCallEnvelope, resolveResultName, safeJsonParse, str,
                                    + all `make*Presenter` factories
  __default__.ts                 ← registerDefaultPresenter call

  read_project_file.ts           ← registerToolPresenter('read_project_file', makeReadFilePresenter())
  read_file.ts                   ← registerToolPresenter('read_file',         makeReadFilePresenter())
  list_project_files.ts          ← registerToolPresenter('list_project_files', makeListDirectoryPresenter())
  list_directory.ts              ← registerToolPresenter('list_directory',     makeListDirectoryPresenter())
  write_project_file.ts
  run_project_command.ts         ← registerToolPresenter('run_project_command', makeRunCommandPresenter())
  run_shell_command.ts           ← registerToolPresenter('run_shell_command',   makeRunCommandPresenter())
  start_and_wait.ts              ← registerToolPresenter('start_and_wait',      makeRunCommandPresenter())
  wait_for_process.ts            ← own file (different call headline: process pid)
  kill_process.ts
  activate_card.ts               ← registerToolPresenter('activate_card', makeCardOutcomePresenter('activated'))
  cancel_card.ts                 ← registerToolPresenter('cancel_card',   makeCardOutcomePresenter('cancelled'))
  restart_card.ts                ← registerToolPresenter('restart_card',  makeCardOutcomePresenter('restarted'))
  delete_card.ts                 ← registerToolPresenter('delete_card',   makeCardOutcomePresenter('deleted'))
  create_card.ts                 ← own file (title fallback chain)
  edit_card.ts                   ← own file (change-keys detail)
  move_card.ts
  get_card.ts
  list_cards.ts
  get_tree.ts
  get_status.ts
  get_plan_diary.ts
  get_card_output.ts
  report_goal_done.ts            ← registerToolPresenter('report_goal_done', makeGoalReportPresenter('done', 'ok'))
  report_goal_failed.ts          ← registerToolPresenter('report_goal_failed', makeGoalReportPresenter('failed', 'danger'))
  report_goal_blocked.ts         ← registerToolPresenter('report_goal_blocked', makeGoalReportPresenter('blocked', 'warn'))
  mark_goal_needs_corrections.ts
  add_note.ts
  list_notes.ts
  get_note.ts
  mark_note_handled.ts
  read_runtime_events.ts         ← registerToolPresenter('read_runtime_events',  makeJsonlTailPresenter('events'))
  read_runtime_errors.ts         ← registerToolPresenter('read_runtime_errors',  makeJsonlTailPresenter('errors'))
  read_control_actions.ts        ← registerToolPresenter('read_control_actions', makeJsonlTailPresenter('control actions'))
  list_processes_tool.ts
  list_agent_sessions.ts
  read_agent_session.ts
  pause_runtime.ts               ← registerToolPresenter('pause_runtime',  makeRuntimeControlPresenter('paused',  '⏸'))
  resume_runtime.ts              ← registerToolPresenter('resume_runtime', makeRuntimeControlPresenter('resumed', '▶'))
  abort_goal.ts                  ← registerToolPresenter('abort_goal',    makeGoalControlPresenter('aborted',    '⛔'))
  restart_goal.ts                ← registerToolPresenter('restart_goal',  makeGoalControlPresenter('restarted',  '↻'))
  load_skill.ts
  mcp_tool_call.ts
  list_card_history.ts
  get_card_history_entry.ts
  diff_card.ts
```

Sample shared-factory site (`read_file.ts`):

```ts
import { registerToolPresenter } from './registry';
import { makeReadFilePresenter } from './helpers';
registerToolPresenter('read_file', makeReadFilePresenter());
```

Sample own-file site (`run_project_command.ts`):

```ts
import { registerToolPresenter } from './registry';
import { makeRunCommandPresenter } from './helpers';
registerToolPresenter('run_project_command', makeRunCommandPresenter());
```

Sample factory body for `makeRunCommandPresenter` (matches current
v3 source at
[../../../../web/src/utils/tool-presenters.ts#L218](../../../../web/src/utils/tool-presenters.ts#L218);
detail is **process pid**, not stdout-tail — r1 review item 5):

```ts
export function makeRunCommandPresenter(): ToolPresenter {
  return {
    call: {
      icon: '⚡',
      call: ({ args }) => ({
        headline: [{ kind: 'code', value: oneLine(args.command, 80) }],
        detail: [],
      }),
    },
    result: {
      iconOk: '↩',
      result: ({ record }) => {
        const rec = asRecord(record);
        const exit = typeof rec?.exitCode === 'number' ? rec.exitCode
                   : typeof rec?.exit_code === 'number' ? rec.exit_code : null;
        const status = typeof rec?.status === 'string' ? rec.status : null;
        const timedOut = rec?.timedOut === true || rec?.timed_out === true;
        const procId = typeof rec?.id === 'string' ? rec.id
                     : typeof rec?.processId === 'string' ? rec.processId : null;
        const segs: string[] = [];
        if (exit !== null) segs.push(`exit ${exit}`);
        if (status) segs.push(status);
        if (timedOut) segs.push('timed out');
        const tone: 'ok' | 'danger' | undefined =
          exit !== null && exit !== 0 ? 'danger' : exit === 0 ? 'ok' : undefined;
        const headline: InlinePart[] = segs.length
          ? [{ kind: 'text', value: segs.join(' · '), tone }]
          : [{ kind: 'text', value: 'completed' }];
        const detail: InlinePart[] = procId
          ? [{ kind: 'text', value: `process ${procId}`, tone: 'muted' }]
          : [];
        return { headline, detail };
      },
    },
  };
}
```

### 3.4 Initialization contract and tree-shake rule

The boot story uses one entrypoint and one barrel. Rules:

1. **Production import path is the barrel.** All app code imports
   from `'../../utils/tool-presenters'` (or whatever relative form
   resolves to `web/src/utils/tool-presenters/index.ts`). No
   production import targets `./registry`, `./helpers`,
   `./__default__`, or any per-tool file directly. An ESLint rule
   (`no-restricted-imports`) is added in the same commit set:

   ```js
   // eslint.config.js (web)
   {
     files: ['web/src/**/*.{ts,vue}'],
     ignores: ['web/src/__tests__/**', 'web/src/utils/tool-presenters/**'],
     rules: {
       'no-restricted-imports': ['error', {
         patterns: [{
           group: ['**/utils/tool-presenters/*', '!**/utils/tool-presenters', '!**/utils/tool-presenters/index'],
           message: 'Import the tool-presenters barrel (utils/tool-presenters), not its internals.',
         }],
       }],
     },
   },
   ```

2. **Barrel imports every per-tool file as a bare statement.**
   `index.ts`:

   ```ts
   // web/src/utils/tool-presenters/index.ts
   // Bare-statement imports keep the side effect (registerToolPresenter)
   // alive under Vite/Rollup tree-shaking. Order does not matter
   // semantically; the default registers last so the assertDefault()
   // guard in registry.ts catches mis-ordered imports during tests.
   import './read_project_file';
   import './read_file';
   import './list_project_files';
   import './list_directory';
   import './write_project_file';
   import './run_project_command';
   import './run_shell_command';
   import './start_and_wait';
   import './wait_for_process';
   import './kill_process';
   import './activate_card';
   import './cancel_card';
   import './restart_card';
   import './delete_card';
   import './create_card';
   import './edit_card';
   import './move_card';
   import './get_card';
   import './list_cards';
   import './get_tree';
   import './get_status';
   import './get_plan_diary';
   import './get_card_output';
   import './report_goal_done';
   import './report_goal_failed';
   import './report_goal_blocked';
   import './mark_goal_needs_corrections';
   import './add_note';
   import './list_notes';
   import './get_note';
   import './mark_note_handled';
   import './read_runtime_events';
   import './read_runtime_errors';
   import './read_control_actions';
   import './list_processes_tool';
   import './list_agent_sessions';
   import './read_agent_session';
   import './pause_runtime';
   import './resume_runtime';
   import './abort_goal';
   import './restart_goal';
   import './load_skill';
   import './mcp_tool_call';
   import './list_card_history';
   import './get_card_history_entry';
   import './diff_card';
   import './__default__';

   export { presentToolCall, presentToolResult } from './registry';
   export type {
     InlinePart, ToolStatus,
     ToolCallPresentation, ToolResultPresentation,
   } from './types';
   ```

3. **`sideEffects` manifest preserves the bare-statement imports.**
   `web/package.json` adds (or extends) a `"sideEffects"` array
   listing the per-tool files. Rollup/Vite drops side-effect-free
   modules from the bundle by default; listing the directory makes
   tree-shaking explicit. The package-relative form below is the
   single canonical wording (r2 review non-blocking #3):

   ```json
   {
     "sideEffects": [
       "src/utils/tool-presenters/**/*.ts",
       "*.css"
     ]
   }
   ```

   Existing `*.css` side effects are preserved; new entry is
   `src/utils/tool-presenters/**/*.ts`. (The current
   `web/package.json` does not declare `sideEffects`; default is
   "all side effects preserved" — but the project rule is to make
   this explicit so future hardening does not silently drop the
   registry.) Every prose reference to this glob in F05 uses the
   same wording.

4. **Defence in depth at runtime.** `assertDefault()` throws if the
   barrel was bypassed (e.g. a test imports `./registry` directly
   without also importing the barrel or `__default__`). The thrown
   message names the correct import path.

5. **Tests use the canonical entrypoint.** Per-tool unit tests
   import `'../../utils/tool-presenters'` (barrel) and call
   `presentToolCall` / `presentToolResult` with raw payloads. They
   do NOT import per-tool files directly; doing so would defeat the
   tree-shake mitigation we are testing (r1 review item 4). The
   barrel-integrity test (§6.5) is the one place that walks the
   directory.

### 3.5 Per-tool coverage table

The table is the **single source of truth** for the matrix
(r1 review item 5). It overrides every prior table in F05
(analysis r2 §5, design r1 §A.3 / §B.4, r2 §3.5). Tone column
applies on the success path; the error path always uses `danger`
(§1.2). Detail for command tools is `process pid` (matching the
existing v3 source at
[../../../../web/src/utils/tool-presenters.ts#L218](../../../../web/src/utils/tool-presenters.ts#L218),
not "stdout-tail"). The `__default__` row is the registered
fallback bucket (§3.1).

| tool name                       | call.icon | call.headline                              | call.detail                          | result.iconOk | result.headline (ok)                       | result.detail (ok)                | result tone (ok)    | factory or own file |
| ------------------------------- | --------- | ------------------------------------------ | ------------------------------------ | ------------- | ------------------------------------------ | --------------------------------- | ------------------- | ------------------- |
| `read_project_file`             | 📖        | `[path]`                                   | `[]`                                 | ↩             | `[N lines · B]` or `[binary file]`         | `[]`                              | muted               | `makeReadFilePresenter` |
| `read_file`                     | 📖        | `[path]`                                   | `[]`                                 | ↩             | same as `read_project_file`                | `[]`                              | muted               | `makeReadFilePresenter` |
| `list_project_files`            | 📂        | `[path]`                                   | `[]`                                 | ↩             | `[N entries]`                              | `[]`                              | muted               | `makeListDirectoryPresenter` |
| `list_directory`                | 📂        | `[path]`                                   | `[]`                                 | ↩             | `[N entries]`                              | `[]`                              | muted               | `makeListDirectoryPresenter` |
| `write_project_file`            | ✏️         | `[path]`                                   | `[N chars]`                          | ↩             | `[wrote B]` or `[wrote file]`              | `[]`                              | ok                  | own file |
| `run_project_command`           | ⚡        | `<code:command>`                           | `[]`                                 | ↩             | `[exit N · status]` or `[completed]`       | `[process <pid>, muted]`          | ok / danger by exit | `makeRunCommandPresenter` |
| `run_shell_command`             | ⚡        | `<code:command>`                           | `[]`                                 | ↩             | same as `run_project_command`              | `[process <pid>, muted]`          | ok / danger         | `makeRunCommandPresenter` |
| `start_and_wait`                | ⚡        | `<code:command>`                           | `[]`                                 | ↩             | same                                       | same                              | same                | `makeRunCommandPresenter` |
| `wait_for_process`              | ⏳        | `[process <pid>]`                          | `[]`                                 | ↩             | `[exit N · status]` or `[completed]`       | `[process <pid>, muted]`          | ok / danger         | own file (different call headline) |
| `kill_process`                  | 🛑        | `[process <pid>]`                          | `[]`                                 | ↩             | `[killed]` or `[process signalled]`        | `[]`                              | ok                  | own file |
| `activate_card`                 | ▶         | `[card <id>]`                              | `[]`                                 | ↩             | `[activated <id>]`                         | `[status, muted]`                 | ok                  | `makeCardOutcomePresenter('activated')` |
| `cancel_card`                   | ⏹         | `[card <id>]`                              | `[]`                                 | ↩             | `[cancelled <id>]`                         | `[status, muted]`                 | ok                  | `makeCardOutcomePresenter('cancelled')` |
| `restart_card`                  | ↻         | `[card <id>]`                              | `[]`                                 | ↩             | `[restarted <id>]`                         | `[status, muted]`                 | ok                  | `makeCardOutcomePresenter('restarted')` |
| `delete_card`                   | 🗑        | `[card <id>]`                              | `[]`                                 | ↩             | `[deleted <id>]`                           | `[]`                              | ok                  | `makeCardOutcomePresenter('deleted')` |
| `create_card`                   | ➕        | `[title or '<type> card' or 'new card']`   | `[type · parent N, muted]`           | ↩             | `[created <id>]`                           | `[type · status, muted]`          | ok                  | own file |
| `edit_card`                     | ✎         | `[card <id>]`                              | `[change <keys>, muted]`             | ↩             | `[edited <id>]`                            | `[changed <keys>, muted]`         | ok                  | own file |
| `move_card`                     | ↳         | `[card <id> → <newParent or 'root'>]`      | `[]`                                 | ↩             | `[moved <id>]`                             | `[]`                              | ok                  | own file |
| `get_card`                      | 🔎        | `[card <id>]`                              | `[]`                                 | ↩             | `[<title>]` or `[card <id>]`               | `[type · status, muted]`          | muted               | own file |
| `list_cards`                    | 🔎        | `[filters or 'all cards']`                 | `[]`                                 | ↩             | `[N cards]`                                | `[]`                              | muted               | own file |
| `get_tree`                      | 🌳        | `[subtree <id>]` or `[project tree]`       | `[]`                                 | ↩             | `[tree fetched]`                           | `[]`                              | muted               | own file |
| `get_status`                    | 📊        | `[project status]`                         | `[]`                                 | ↩             | `[summary, muted]`                         | `[]`                              | muted               | own file |
| `get_plan_diary`                | 📔        | `[goal <id>]`                              | `[]`                                 | ↩             | `[N entries]`                              | `[]`                              | muted               | own file |
| `get_card_output`               | 🖥        | `[card <id> · last N lines]`               | `[]`                                 | ↩             | `[N lines · B]`                            | `[]`                              | muted               | own file |
| `report_goal_done`              | ✅        | `[status_text, muted]`                     | `[]`                                 | ↩             | `[recorded done report]`                   | `[]`                              | ok                  | `makeGoalReportPresenter('done','ok')` |
| `report_goal_failed`            | ❌        | `[status_text, muted]`                     | `[]`                                 | ↩             | `[recorded failed report, danger]`         | `[]`                              | danger              | `makeGoalReportPresenter('failed','danger')` |
| `report_goal_blocked`           | ⛔        | `[status_text, muted]`                     | `[]`                                 | ↩             | `[recorded blocked report, warn]`          | `[]`                              | warn                | `makeGoalReportPresenter('blocked','warn')` |
| `mark_goal_needs_corrections`   | ⚠        | `[goal <id>]`                              | `[N issues, muted]`                  | ↩             | `[corrections queued, warn]`               | `[]`                              | warn                | own file |
| `add_note`                      | 📝        | `[card <id> [kind]]`                       | `[content, muted]`                   | ↩             | `[note <id>]` or `[note added]`            | `[]`                              | ok                  | own file |
| `list_notes`                    | 📋        | `[card <id>]`                              | `[]`                                 | ↩             | `[N notes]`                                | `[]`                              | muted               | own file |
| `get_note`                      | 📋        | `[note <id> on <card id>]`                 | `[]`                                 | ↩             | `[content, muted]`                         | `[]`                              | muted               | own file |
| `mark_note_handled`             | ✓         | `[note <id>]`                              | `[]`                                 | ↩             | `[note handled]`                           | `[]`                              | ok                  | own file |
| `read_runtime_events`           | 📜        | `[events × N [kind]]`                      | `[]`                                 | ↩             | `[N events]`                               | `[]`                              | muted               | `makeJsonlTailPresenter('events')` |
| `read_runtime_errors`           | 🩺        | `[errors × N]`                             | `[]`                                 | ↩             | `[N errors]`                               | `[]`                              | muted               | `makeJsonlTailPresenter('errors')` |
| `read_control_actions`          | 🧭        | `[control actions × N]`                    | `[]`                                 | ↩             | `[N control actions]`                      | `[]`                              | muted               | `makeJsonlTailPresenter('control actions')` |
| `list_processes_tool`           | ⚙         | `[filter <keys>]` or `[all processes]`     | `[]`                                 | ↩             | `[N processes]`                            | `[]`                              | muted               | own file |
| `list_agent_sessions`           | 👥        | `[agent sessions]`                         | `[]`                                 | ↩             | `[N sessions]`                             | `[]`                              | muted               | own file |
| `read_agent_session`            | 🧵        | `[session <id>]`                           | `[]`                                 | ↩             | `[N messages]`                             | `[]`                              | muted               | own file |
| `pause_runtime`                 | ⏸         | `[pause runtime]`                          | `[]`                                 | ↩             | `[paused]`                                 | `[]`                              | ok                  | `makeRuntimeControlPresenter('paused','⏸')` |
| `resume_runtime`                | ▶         | `[resume runtime]`                         | `[]`                                 | ↩             | `[resumed]`                                | `[]`                              | ok                  | `makeRuntimeControlPresenter('resumed','▶')` |
| `abort_goal`                    | ⛔        | `[goal <id>]`                              | `[]`                                 | ↩             | `[aborted]`                                | `[]`                              | ok                  | `makeGoalControlPresenter('aborted','⛔')` |
| `restart_goal`                  | ↻         | `[goal <id>]`                              | `[]`                                 | ↩             | `[restarted]`                              | `[]`                              | ok                  | `makeGoalControlPresenter('restarted','↻')` |
| `load_skill`                    | 🪄        | `[skill <name>]`                           | `[]`                                 | ↩             | `[loaded <name>]` or `[skill loaded]`      | `[]`                              | ok                  | own file |
| `mcp_tool_call`                 | 🔌        | `[tool <name>]`                            | `[params, muted]`                    | ↩             | `[summary, muted]`                         | `[]`                              | muted               | own file |
| `list_card_history`             | 🕘        | `[card <id>]`                              | `[]`                                 | ↩             | `[N entries]`                              | `[]`                              | muted               | own file |
| `get_card_history_entry`        | 🕘        | `[card <id> @ v<seq>]`                     | `[]`                                 | ↩             | `[author · date, muted]`                   | `[]`                              | muted               | own file |
| `diff_card`                     | 🔀        | `[card <id>]`                              | `[]`                                 | ↩             | `[N changes]`                              | `[]`                              | muted               | own file |
| `__default__` (unknown)         | 🔧        | `[(keys)]` or `[]`                         | `[oneLine(args), muted]`             | ↩             | `[oneLine(summary/message/raw), muted]`    | `[]`                              | ok / danger by §1.2 | `__default__.ts` |

Path arguments for `read_project_file`, `read_file`,
`write_project_file`, `list_project_files`, `list_directory`,
`get_card_output` are emitted as `{ kind: 'text', value: path }`,
not `{ kind: 'file' }`, because v3 does not expose a project root
(F05 analysis r2 §4.3). The day a project root lands, only the
relevant factories switch to `{ kind: 'file', path, root: 'project' }`
and the chip routing follows; no other code changes.

### 3.6 `EXPECTED_TOOL_NAMES`

```ts
// web/src/__tests__/tool-presenters/coverage.test.ts (excerpt; see §6.5)
const EXPECTED_TOOL_NAMES = [
  'read_project_file','read_file','list_project_files','list_directory',
  'write_project_file','run_project_command','run_shell_command','start_and_wait',
  'wait_for_process','kill_process',
  'activate_card','cancel_card','restart_card','delete_card','create_card','edit_card','move_card','get_card','list_cards',
  'get_tree','get_status','get_plan_diary','get_card_output',
  'report_goal_done','report_goal_failed','report_goal_blocked','mark_goal_needs_corrections',
  'add_note','list_notes','get_note','mark_note_handled',
  'read_runtime_events','read_runtime_errors','read_control_actions',
  'list_processes_tool','list_agent_sessions','read_agent_session',
  'pause_runtime','resume_runtime','abort_goal','restart_goal',
  'load_skill','mcp_tool_call','list_card_history','get_card_history_entry','diff_card',
] as const;
```

The coverage test asserts `_registryKeysForTest().sort()` equals
`[...EXPECTED_TOOL_NAMES].sort()` after barrel import. Any
additional or missing registration fails CI.

---

## 4. Chip integration and content components

### 4.1 `ToolChip` prop bag (canonical eight-prop binding)

The chip lives in `web/src/components/conversation/ToolChip.vue`
and is implemented in the **F03 PR** (per F02 r2 §1.3.14 landing
clause; per F03 r2 §7.2; per F04 r2 §4.1 adapter callers). The
**canonical, binding prop bag** for cross-document implementation
is the eight-prop signature below. This is the source of truth
for any cross-issue contradiction; F02 r2's six-prop snippets are
errata (see §4.4).

```ts
// web/src/components/conversation/ToolChip.vue (F03-owned implementation, F05 contract)
import type {
  ToolCallPresentation,
  ToolResultPresentation,
} from '../../utils/tool-presenters';
import type { ToolPairStatus } from '../../utils/agent-timeline/types';

defineProps<{
  call: ToolCallPresentation;          // from F05 — always present
  result: ToolResultPresentation | null; // from F05 — null when no result yet
  callContent: string;                 // RAW producer payload for the call message
  resultContent: string | null;        // RAW producer payload for the result message, or null
  status: ToolPairStatus;              // F03 r2 §3.3: 'pending' | 'ok' | 'error' | 'orphan' | 'missing'
  expanded: boolean;
  detailsId: string;                   // e.g. `tool-detail-${pair.toolUseId}`
  timestamp?: string;
}>();
defineEmits<{ (e: 'toggle'): void }>();
```

Status → Card tone mapping (verbatim from F03 r2 §7.2; F02 r2 §1.3.14
is the same; restated here so any single document is sufficient
for an implementer to typecheck):

| `status`    | `<Card>` tone | rationale |
| ----------- | ------------- | --------- |
| `'pending'` | `warn`        | in-flight, no result yet |
| `'ok'`      | `accent`      | successful result |
| `'error'`   | `danger`      | failed result |
| `'orphan'`  | `warn`        | result with no call (surfaced as warning, not error) |
| `'missing'` | `warn`        | call present, no result yet; headline gets a muted "(no result yet)" suffix |

Per r1 review item 2: `ToolCallPresentation` / `ToolResultPresentation`
remain pure structured outputs. The raw producer payloads
(`call.content` and `result?.content` for persisted entries; a
synthesised text for pending invocations) travel as the **separate
string props named `callContent` and `resultContent`** — no other
spelling is accepted. They are forwarded by F04 r2's adapter
(`adaptChatMessageToToolChip`, `adaptPendingInvocationToToolChip`)
and by F03's `toolChipPropsFor(pair)` helper. The chip then mounts
F05's `<FormattedContent :content="callContent" />` and (when
`resultContent !== null`) a second `<FormattedContent>` for the
result.

DOM rules (asserted in tests, §6.2):

- Outer element is `<Card role="group" :data-status="status">`,
  **not** a `<button>`.
- Exactly one `<button>` per chip: the expand toggle.
- `<router-link>` / `<a>` / `<code>` / `<span>` emitted by
  `<InlineParts>` are **siblings** of the toggle.
- The expanded body is a sibling of the head row, with `id ===
  detailsId`; the toggle's `aria-controls` references it.
- The chip emits only `toggle`; no `navigateFile`, no
  `navigateUrl`, no `openFile` — those would require the chip to
  know about the file store / router.

### 4.2 `FormattedContent` and `JsonView` stay content-owned

Files relocated by F02 r2 §1.3 / r1 §1.4–§1.5 (unchanged):

```
web/src/components/content/
  CodeBlock.vue           ← relocated from components/code/ by F02
  MarkdownText.vue        ← relocated from components/code/ by F02
  JsonView.vue            ← NEW (see r1 §1.4)
  FormattedContent.vue    ← NEW (see r1 §1.5)
  InlineParts.vue         ← NEW (see r1 §1.6, sub-component)

web/src/utils/
  json-tokenize.ts        ← NEW (see r1 §1.3)
```

The skeleton TypeScript and Vue from r1 §1.3–§1.6 is unchanged
in r2/r3. Only the registry surface (§3), the prop-bag binding
(§4.1), the cross-document errata (§4.4), the source-link depths
(throughout), and the `sideEffects` glob wording (§3.4) change.

`<InlineParts>` belongs in `content/` because (a) F03 r2 §7.2
imports it from `'../content/InlineParts.vue'`, (b) it has no
store/router/WS dependency and qualifies for `content/` under
F02 r2 §1.1's discriminator, and (c) it renders `<router-link>`
to the `files` route only through Vue Router's resolved
`<RouterLink>` component, not by importing the store.

### 4.3 `FilesView` routing (unchanged from r2)

[../../../../web/src/views/FilesView.vue#L234-L250](../../../../web/src/views/FilesView.vue#L234-L250)
becomes:

```ts
function applyQueryPath(): void {
  const p = route.query.path;
  const r = route.query.root;
  if (typeof p !== 'string') return;
  if (r === 'meta')   { fileStore.navigateMeta(p).catch(() => {});   return; }
  if (r === 'output') { fileStore.navigateOutput(p).catch(() => {}); return; }
  // Per the project guideline, no bare ?path= fallback survives. Every
  // navigation site emits { path, root } unconditionally; any other shape
  // is a caller bug and we ignore it.
}
watch(() => [route.query.path, route.query.root], () => applyQueryPath());
```

The other in-file callsites
([FilesView.vue#L32](../../../../web/src/views/FilesView.vue#L32),
[#L44](../../../../web/src/views/FilesView.vue#L44),
[#L71](../../../../web/src/views/FilesView.vue#L71),
[#L83](../../../../web/src/views/FilesView.vue#L83),
[#L98](../../../../web/src/views/FilesView.vue#L98)) keep their direct
`navigateMeta` / `navigateOutput` calls — they are not router-driven.

### 4.4 Cross-document errata (binding)

The r2 review observed that F02 r2 still publishes a stale
six-prop `ToolChip` API and uses prose names `callContentRaw` /
`resultContentRaw` that do not exist in F03 r2, F04 r2, or F05.
Until F02 r3 lands, F05 r3 declares the following as binding
errata against F02 r2:

- **F02 r2 §1.3.14 "ToolChip.vue (final API; ships in F03 PR)"**
  — the `defineProps<{…}>()` snippet omits `callContent: string`
  and `resultContent: string | null`. **Errata:** the canonical
  contract is the eight-prop bag in §4.1 of this document. The
  F02 r2 six-prop snippet is non-binding; implementers must use
  the eight-prop signature.
- **F02 r2 §3 "consolidated prop-interface" `ToolChip.vue` block**
  — same omission. **Errata:** same fix.
- **F02 r2 §1.3.14 markup contract prose** — uses the names
  `callContentRaw` and `resultContentRaw`. **Errata:** the
  canonical names are `callContent` and `resultContent` (no `Raw`
  suffix). They appear in F03 r2 §7.2, F04 r2 §4.1, and §4.1 of
  this document; the `*Raw` spellings appear nowhere else in the
  spec tree and must not enter the codebase.

The project rule is architecture-first, no backward compatibility:
there is **no transitional alias**. The chip ships with exactly
the eight props named in §4.1; if any code emits `callContentRaw`
or a six-prop bag, it is a bug to be fixed, not a contract to be
honoured.

F02 r3 must (a) replace the two snippets above with the §4.1
contract, (b) rename `*ContentRaw` to `*Content` in prose, and (c)
add a coverage-map row pointing at this section. F05 r3 owns the
canonical contract; F02 r3 owns the file taxonomy and tone table.

---

## 5. Canonical import paths and file deletions

### 5.1 Canonical public path

- App code / tests import from `'../../utils/tool-presenters'`
  (resolves to `web/src/utils/tool-presenters/index.ts`).
- The existing single-file
  [../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)
  is **deleted** in the same commit that introduces the directory.
  No re-export shim. Resolution order in Vite / TypeScript still
  gives `'../../utils/tool-presenters'` → `tool-presenters/index.ts`
  because TS prefers a directory's `index.ts` after the file
  resolution fails, and the file no longer exists.

### 5.2 Deletions landed in the same change set

- [../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)
  (380 lines) — deleted.
- The `expandedDetail` / `toolCallView` / `toolResultView` helpers
  and the `tc-header` / `tr-header` templates in
  [../../../../web/src/components/agents/AgentConversationView.vue#L63-L103](../../../../web/src/components/agents/AgentConversationView.vue#L63-L103)
  — deleted (replaced by `<ToolChip>` per F03 r2 §10).
- The in-line `<button class="tool-chip">` markup and scoped CSS
  in [../../../../web/src/components/chat/AnalystChatPanel.vue#L36-L75](../../../../web/src/components/chat/AnalystChatPanel.vue#L36-L75)
  / [#L298-L347](../../../../web/src/components/chat/AnalystChatPanel.vue#L298-L347)
  — deleted in the F03 PR per F03 r2 §8.2 / §10.
- The `string` headline type and `detail?: string` shape in the
  pre-F05 presenter exports — deleted; replaced by `InlinePart[]`
  shape (§1.2).

### 5.3 No back-compat re-exports

There is no transitional module that re-exports the new types
under the old name (`ToolPresentationView` etc.). F03 r2's
analysis sketched such a type for cross-issue communication; the
binding F03 r2 design (§7.2) consumes the F05 r2 shapes
(`ToolCallPresentation`, `ToolResultPresentation`) directly, so no
shim is needed.

---

## 6. Test plan

### 6.1 Pure-utility tests (unchanged from r1)

- `web/src/__tests__/json-tokenize.test.ts` — 12 cases on the
  tokeniser (r1 §A.4).
- `web/src/__tests__/JsonView.test.ts` — three component cases
  (r1 §A.4).
- `web/src/__tests__/FormattedContent.test.ts` — eight cases
  (r1 §A.4).

### 6.2 `ToolChip` ARIA / DOM contract test (new under §F05)

The chip is implemented by F03 r2 design §7.2; F03 r2 §11.1 owns
the chip-contract test file. F05 r3 lists the cases that protect
F05's contract (the `InlinePart` field names, the routing of file
parts, the raw-content body via `<FormattedContent>`, and the
eight-prop bag from §4.1):

- `ToolChip > renders exactly one <button> per chip (the toggle).`
- `ToolChip > root element is <div role="group">, not <button>.`
- `ToolChip > <a> rendered for url parts has target="_blank" and rel="noopener noreferrer".`
- `ToolChip > <router-link> rendered for file parts targets { name: 'files', query: { path, root } }.`
- `ToolChip > inline links are siblings of the toggle, not descendants` (DOM walk: `link.closest('button')` returns null).
- `ToolChip > InlinePart field names are read from F05 shape (value, path/root, url) — not aliases (text/to/href).`
- `ToolChip > expanded body is a sibling of the head row, id matches detailsId.`
- `ToolChip > expanded body mounts <FormattedContent :content="callContent" />.`
- `ToolChip > expanded body mounts <FormattedContent :content="resultContent" /> only when resultContent !== null.`
- `ToolChip > does not pass call/result presentations into <FormattedContent>.`
- `ToolChip > prop bag is exactly the eight names from §4.1; passing callContentRaw or resultContentRaw fails Vue prop validation in dev.`

F03 r2 §11.1 already lists overlapping cases; F05 r3 owns these
specifically because they enforce F05's contract. They live in the
same test file (`web/src/__tests__/conversation/ToolChip.test.ts`).

### 6.3 `InlineParts` routing test (new)

`web/src/__tests__/content/InlineParts.test.ts`:

- `InlineParts > file part renders <router-link> with { name: 'files', query: { path, root: 'meta' } } when root is meta`
- `InlineParts > file part renders <router-link> with { ..., root: 'output' } when root is output`
- `InlineParts > url part renders <a> with target="_blank" rel="noopener noreferrer"`
- `InlineParts > code part renders <code class="code-inline"> with raw value`
- `InlineParts > text part renders <span class="tone-danger"> when tone === 'danger'`
- `InlineParts > text part omits tone class when tone is undefined`
- `InlineParts > short-path truncation applies only to the displayed text, not to the query.path of <router-link>`

### 6.4 `FilesView` route handling test (new)

`web/src/__tests__/files-view-route.test.ts`:

- `applyQueryPath > calls navigateMeta when ?root=meta&path=…`
- `applyQueryPath > calls navigateOutput when ?root=output&path=…`
- `applyQueryPath > does nothing when ?path= is present without ?root`
- `applyQueryPath > does nothing when ?path= is missing`
- `applyQueryPath > does nothing on an unrecognised ?root=… value`
- `applyQueryPath > re-runs when either ?path or ?root changes (watcher widened to both keys)`

### 6.5 Registry and barrel-integrity tests

`web/src/__tests__/tool-presenters/registry.test.ts`:

- `presentToolCall > resolves a registered name (read_project_file)`
- `presentToolCall > falls back to __default__ for an unknown name`
- `presentToolCall > uses fallbackName when the body lacks a function name`
- `presentToolResult > respects ctx.kind === 'tool_error' even when payload looks healthy`
- `presentToolResult > respects ctx.tool override when payload has no tool field`
- `presentToolResult > error path: status === 'error', headline single danger text, detail === []`
- `presentToolResult > error path: per-tool result presenter is NOT invoked`
- `registerToolPresenter > throws on duplicate registration`
- `registerDefaultPresenter > throws on duplicate registration`
- `assertDefault > throws with the "import barrel" hint when default is missing`

`web/src/__tests__/tool-presenters/coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import '../../utils/tool-presenters';                    // canonical entrypoint
import {
  _registryKeysForTest,
  _internalRegistryEntriesForTest,
} from '../../utils/tool-presenters/registry';

const EXPECTED_TOOL_NAMES = [/* see §3.6 */] as const;

describe('tool-presenter registry coverage', () => {
  const keys = _registryKeysForTest().sort();
  const expected = [...EXPECTED_TOOL_NAMES].sort();

  it('registers exactly the expected tool names (no aliases, no extras, no missing)', () => {
    expect(keys).toEqual(expected);
  });

  it('every expected tool name has BOTH a call and a result presenter', () => {
    for (const [name, presenter] of _internalRegistryEntriesForTest()) {
      expect(presenter.call, `${name}.call missing`).toBeDefined();
      expect(presenter.result, `${name}.result missing`).toBeDefined();
    }
  });
});
```

Both `_*ForTest` helpers are namespaced with the underscore prefix
and excluded from production import linting via the ESLint rule in
§3.4.

`web/src/__tests__/tool-presenters/barrel-integrity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../../utils/tool-presenters/', import.meta.url).pathname;

describe('tool-presenters barrel integrity', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !['index.ts', 'registry.ts', 'types.ts', 'helpers.ts'].includes(f));
  const barrel = readFileSync(join(DIR, 'index.ts'), 'utf8');

  it('every presenter file in the directory is imported by index.ts as a bare statement', () => {
    for (const f of files) {
      const stem = f.replace(/\.ts$/, '');
      const importLine = `import './${stem}';`;
      expect(barrel, `${stem} missing from index.ts`).toContain(importLine);
    }
  });

  it('__default__.ts is the last bare-statement import in index.ts', () => {
    const importStatements = barrel.match(/^import '\.\/[^']+';$/gm) ?? [];
    expect(importStatements[importStatements.length - 1]).toBe(`import './__default__';`);
  });

  it('index.ts re-exports presentToolCall, presentToolResult, and the four public types', () => {
    expect(barrel).toMatch(/export \{[^}]*presentToolCall[^}]*\} from '\.\/registry'/);
    expect(barrel).toMatch(/export \{[^}]*presentToolResult[^}]*\} from '\.\/registry'/);
    expect(barrel).toMatch(/export type \{[^}]*InlinePart[^}]*\} from '\.\/types'/);
    expect(barrel).toMatch(/export type \{[^}]*ToolStatus[^}]*\} from '\.\/types'/);
    expect(barrel).toMatch(/export type \{[^}]*ToolCallPresentation[^}]*\} from '\.\/types'/);
    expect(barrel).toMatch(/export type \{[^}]*ToolResultPresentation[^}]*\} from '\.\/types'/);
  });
});
```

The barrel-integrity test is the canary that catches "added a new
per-tool file but forgot to import it from `index.ts`" before
CI's higher-level coverage tests run.

### 6.6 Per-tool presenter unit tests

One file per tool under `web/src/__tests__/tool-presenters/<tool>.test.ts`.
Every test imports `'../../utils/tool-presenters'` (the barrel)
and calls `presentToolCall` / `presentToolResult` with raw fixture
strings. Helper utilities:

```ts
// web/src/__tests__/tool-presenters/_helpers.ts (test-local)
import type { InlinePart } from '../../utils/tool-presenters';
export function partsOfKind<K extends InlinePart['kind']>(parts: InlinePart[], kind: K): Extract<InlinePart, { kind: K }>[] {
  return parts.filter((p): p is Extract<InlinePart, { kind: K }> => p.kind === kind);
}
export function textValues(parts: InlinePart[]): string[] {
  return parts.flatMap((p) => (p.kind === 'text' || p.kind === 'code') ? [p.value] : []);
}
```

Named cases (one `describe` per tool):

- `read_project_file > call emits a text part for the path` (asserts no `file` part because project root is non-clickable per F05 analysis r2 §4.3).
- `read_project_file > result on text payload emits "<N lines · B>" with tone muted`.
- `read_project_file > result on binary payload emits "binary file" with no tone`.
- `read_file > call and result behave identically to read_project_file for the same payload` (factory sharing assertion, NOT alias test).
- `list_project_files > call emits the directory path`.
- `list_project_files > result emits "<N entries>"`.
- `list_directory > behaves identically to list_project_files for the same payload`.
- `write_project_file > call emits the path and a "<N chars>" detail`.
- `write_project_file > result emits "wrote <B>" when bytes is a number, else "wrote file"`.
- `run_project_command > call emits a code part with the command (truncated to 80)`.
- `run_project_command > result on exit 0 emits text tone ok, headline "exit 0[ · status]", detail "process <pid>" muted`.
- `run_project_command > result on non-zero exit emits tone danger`.
- `run_project_command > result without an exit code emits "completed"`.
- `run_project_command > result without a process id emits an empty detail`.
- `run_shell_command > delegates to run_project_command via shared factory`.
- `start_and_wait > delegates to run_project_command via shared factory`.
- `wait_for_process > call emits "process <pid>" headline (own file, distinct from command tools)`.
- `kill_process > call emits "process <pid>"; result emits "killed" or "process signalled"`.
- per card-outcome verb (`activate_card`, `cancel_card`, `restart_card`, `delete_card`): `call emits "card <id>"; result emits "<verb> <id>" with status detail muted`.
- `create_card > call uses title when provided, else "<type> card" when type provided, else "new card"`.
- `create_card > result emits "created <id>" with "<type> · <status>" detail muted`.
- `edit_card > call lists changed keys in detail with muted tone`.
- `edit_card > result emits "edited <id>"`.
- `move_card > call emits "card <id> → <newParent or 'root'>"`.
- `move_card > result emits "moved <id>"`.
- `get_card > result emits the card title with type/status detail muted`.
- `list_cards > call emits "all cards" when args are empty, else "<k>=<v> · …"`.
- `list_cards > result emits "<N> cards"`.
- `get_tree > call emits "project tree" by default, "subtree <id>" when rootId provided`.
- `get_status > call emits "project status"; result emits muted summary`.
- `get_plan_diary > call emits "goal <id>"; result emits "<N entries>"`.
- `get_card_output > call emits "card <id> · last <N> lines"; result emits "<N lines · B>"`.
- `report_goal_done > result emits "recorded done report" with tone ok`.
- `report_goal_failed > result emits "recorded failed report" with tone danger` (success path; error path is separate).
- `report_goal_blocked > result emits "recorded blocked report" with tone warn`.
- `mark_goal_needs_corrections > call shows <N issues> in detail muted`.
- `mark_goal_needs_corrections > result emits "corrections queued" with tone warn`.
- `add_note > call emits "card <id> [kind]" with content muted detail; result emits "note <id>"`.
- `list_notes > call emits "card <id>"; result emits "<N notes>"`.
- `get_note > call emits "note <id> on <card id>"; result emits content muted`.
- `mark_note_handled > result emits "note handled"`.
- per JSONL-tail tool (`read_runtime_events`, `read_runtime_errors`, `read_control_actions`): `call emits the limited preview; result emits "<N> <label>"`.
- `list_processes_tool > call emits filter keys or "all processes"; result emits "<N processes>"`.
- `list_agent_sessions > call emits "agent sessions"; result emits "<N sessions>"`.
- `read_agent_session > call emits "session <id>"; result emits "<N messages>"`.
- per runtime-control verb (`pause_runtime`, `resume_runtime`): `call/result emit static text per table`.
- per goal-control verb (`abort_goal`, `restart_goal`): `call/result emit static text per table`.
- `load_skill > call emits skill name; result emits "loaded <name>" or "skill loaded"`.
- `mcp_tool_call > call emits MCP tool name with muted params detail; result emits muted summary`.
- `list_card_history > call emits "card <id>"; result emits "<N entries>"`.
- `get_card_history_entry > call emits "card <id> @ v<seq>"; result emits "author · date" muted`.
- `diff_card > call emits "card <id>"; result emits "<N changes>"`.
- `__default__ > call emits "(keys)" or empty headline plus muted args in detail`.
- `__default__ > result on ok payload emits muted summary; status ok`.
- `__default__ > result on payload with ok:false sets status error and tone danger`.

### 6.7 Agent + analyst integration tests

These tests already live in F03 r2 §11.1 (`ToolChip.test.ts`) and
F04 r2 §9.1 (`analyst-chat-panel.test.ts`). F05 r3 adds NO new
files at the integration layer; it only ensures the cases below
are present in those existing files, with the eight-prop names
from §4.1 used verbatim:

- F03 chip integration: `RoundCard > each ToolPair renders one <ToolChip> bound via toolChipPropsFor(pair); callContent === pair.call?.content ?? ''; resultContent === pair.result?.content ?? null`.
- F04 chip integration: `MessageList > persisted tool_pair items render <ToolChip v-bind="adaptChatMessageToToolChip(call, result, expanded)">`.
- F04 chip integration: `MessageList > pending invocations render <ToolChip v-bind="adaptPendingInvocationToToolChip(p, expanded)"> with result=null and status='pending'`.
- F04 chip integration: `MessageList > the adapter output is exactly the eight keys from §4.1; no callContentRaw, no resultContentRaw, no extra keys`.

### 6.8 Tests deleted

- The old `web/src/__tests__/tool-presenters.test.ts` (if any
  string-headline assertions exist) — deleted, replaced by the
  per-tool files in §6.6.
- Any test that imports `tool-presenters` from a deep path
  (`'../../utils/tool-presenters/registry'` etc.) from production
  code — deleted or rewritten to import the barrel.

---

## 7. Alternatives revisited

The alternatives section in r1 §9 (`a`/`b`/`c` — content tree,
schema-driven, MarkdownText-for-everything) is unchanged in r2/r3.
No new alternatives are introduced; the r1 and r2 review blockers
were all fixable inside Proposal B without changing the menu.

---

## 8. Out of scope (unchanged)

- Backend project file root (`root: 'project'`).
- Richer `MarkdownText` (headings/bullets/emphasis).
- Replacing `highlight.js` in `CodeBlock`.
- Streaming-aware JSON tokeniser.
- Bundle-splitting the presenter registry (lazy import per tool).
- Custom expand bodies on `ToolPresenter` (Proposal B forward seat
  for F03 r2 §11's `diff_card` follow-up; not implemented here).

---

## 9. Result

- Absolute path: `/home/salva/g/ml/saivage-v3/SPEC/2026-05/review-ui-port-from-v2/F05-tool-detail-rendering/02-design-r3.md`
- Chosen proposal: **B (Registry-based presenters)**, with the
  r1 and r2 review blockers resolved:
  1. (r1) Alias subsystem removed; shared factories in `helpers.ts`
     replace it (§3.2).
  2. (r1) Raw-content ownership lives on the chip
     (`callContent` / `resultContent`), not on the presentations
     (§1.2, §4.1).
  3. (r1) Single canonical public path:
     `web/src/utils/tool-presenters/` with `index.ts` as the only
     production import target (§3.1, §3.4, §5).
  4. (r1) Explicit initialization contract: barrel-only imports,
     ESLint `no-restricted-imports`, `sideEffects` manifest
     (canonical glob `src/utils/tool-presenters/**/*.ts`),
     `assertDefault()` runtime guard, barrel-integrity test
     (§3.4, §6.5).
  5. (r1) Per-tool matrix reconciled (`run_project_command` detail
     = `process pid`; coverage test asserts both halves registered
     per name; no fallthrough) (§3.5, §6.5).
  6. (r1) Browser-facing seam tests added: `ToolChip`,
     `InlineParts`, `FilesView` routing, agent + analyst
     integration (§6).
  7. (r2) Canonical eight-prop `ToolChip` contract restated in
     §4.1 with status→tone table; F02 r2's six-prop snippets and
     `callContentRaw` / `resultContentRaw` names declared errata
     to be fixed at F02 r3 / implementation time (§4.4). A new
     test case (§6.2, §6.7) asserts the prop names match §4.1
     exactly.
  8. (r2) Source-link relative depth corrected from three to four
     `..` segments throughout.
  9. (r2) `sideEffects` glob wording standardised to
     `src/utils/tool-presenters/**/*.ts` everywhere (§3.4, §9).
