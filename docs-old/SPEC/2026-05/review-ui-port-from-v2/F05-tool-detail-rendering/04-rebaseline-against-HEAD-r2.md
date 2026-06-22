# F05 — Rebaseline against HEAD `eb98caf` (r2)

Writer round 2. Addresses the reviewer findings on r1 (missing
plan §3.7 per-tool test deliverable row; missing barrel-restriction
location note). This document supersedes
[04-rebaseline-against-HEAD-r1.md](04-rebaseline-against-HEAD-r1.md).

This is a **binding addendum** to the F05 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis, design, and plan are unchanged. A reader
who has never seen earlier review rounds can implement the
remaining F05 work by combining the approved design + plan +
this rebaseline.

The implementer MUST NOT recreate files listed in §2, MUST NOT
silently descope anything in §3 or §4, and MUST follow the
nothing-lost invariant in §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F05 landing commit: `feb442f` (mailbox-005).

---

## 2. Already-landed deliverables (NO-OP)

### 2.1 Tool-presenter registry

`web/src/utils/tool-presenters/` contains the barrel `index.ts`,
`registry.ts`, `types.ts`, `helpers.ts`, `__default__.ts`, and
45 per-tool modules (52 files total). Legacy
`web/src/utils/tool-presenters.ts` is deleted.

### 2.2 `json-tokenize.ts`

[web/src/utils/json-tokenize.ts](../../../../web/src/utils/json-tokenize.ts)
landed; unit tests
`web/src/__tests__/utils/json-tokenize.test.ts` are present.

### 2.3 `InlinePart` discriminated union

`web/src/utils/tool-presenters/types.ts` line 3 declares the
`file` variant on the canonical shape:

```ts
| { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
```

No `name` field, no `pathPrefix` field.

### 2.4 Content components

`web/src/components/content/{JsonView,FormattedContent,InlineParts}.vue`
landed (foundation also satisfies F02 §2.2).

### 2.5 Per-tool router migration

All call sites previously branching on tool name have been
moved to `getToolPresenter(name)`. No `if (toolName === ...)`
branches remain in `web/src/components/agents/AgentConversationView.vue`
or `web/src/components/chat/AnalystChatPanel.vue` (verified by
grep; legacy router is gone).

### 2.6 Barrel-import restriction (plan C6)

The plan's ESLint barrel-import restriction is enforced by
[scripts/check-web-component-boundaries.cjs](../../../../scripts/check-web-component-boundaries.cjs)
lines 86–87:

```
'production code must import the tool presenter barrel, not …'
```

This is a deviation from the plan's wording (which suggested a
`web/eslint.config.js` rule); functionally equivalent and
running via `npm run lint`. No further work required for this
row.

---

## 3. Remaining deliverables (IN SCOPE)

### 3.1 FilesView canonical routing — plan §2 C9

`web/src/views/FilesView.vue` still uses two separate panels
(`fetchMetaFiles` / `fetchOutputFiles`) with bespoke selectors
([web/src/views/FilesView.vue:20](../../../../web/src/views/FilesView.vue#L20)
onwards). The design contract is a single canonical
URL-driven view:

- Route shape: `/files?root=meta|output&path=<rel>`.
- Single panel listing whose data is selected from the URL
  (router-driven, not click-driven `metaFiles` vs `outputFiles`
  state).
- `<InlineParts>` links from elsewhere (e.g. tool presenters
  returning `kind: 'file'`) navigate via
  `router.push({ path: '/files', query: { root, path } })`.
- Bespoke selectors `.files-global-banner`, `.panel-root`,
  `.panel-refresh-btn`, `.panel-loading`, `.panel-empty`,
  `.panel-crumbs`, `.panel-card` are DELETED in the same commit.
- Co-committed with the F02 surface rewrite of `FilesView.vue`
  (F02 rebaseline r2 §3.5 row C9); the routing change is F05's
  contribution, the selector deletions are F02's. One commit,
  one PR-stage.

### 3.2 Per-tool test suite — plan §3.7 (C7)

At HEAD `web/src/__tests__/` contains only:

- `web/src/__tests__/tool-presenters.test.ts` (legacy flat file,
  pre-split shape).
- `web/src/__tests__/tool-presenters.coverage.test.ts`.
- `web/src/__tests__/tool-presenters.barrel-integrity.test.ts`.

There is no `web/src/__tests__/tool-presenters/` subdirectory.
The plan §3.7 (C7) inventory demands one test file per per-tool
presenter under `web/src/__tests__/tool-presenters/<tool>.test.ts`
(45 files matching the 45 per-tool modules) plus `_helpers.ts`
and a `registry.test.ts`. The legacy flat
`web/src/__tests__/tool-presenters.test.ts` is **deleted** in
the same commit; `tool-presenters.coverage.test.ts` and
`tool-presenters.barrel-integrity.test.ts` are kept (they cover
cross-cutting invariants and are not per-tool tests).

Deliverable:

| Path | Action |
| --- | --- |
| `web/src/__tests__/tool-presenters/_helpers.ts` | new — shared fixture helpers per plan §3.7 |
| `web/src/__tests__/tool-presenters/registry.test.ts` | new — registry exhaustiveness, default fallback, name→presenter resolution |
| `web/src/__tests__/tool-presenters/<tool>.test.ts` × 45 | new — one per per-tool module under `web/src/utils/tool-presenters/`. The 45 tool names are enumerated in plan analysis §3.1. |
| `web/src/__tests__/tool-presenters.test.ts` | **deleted** — replaced by the nested suite |

### 3.3 `ToolChip.vue` template — plan §1.3 row (F03 R2 dependency)

The F05 plan §1.3 row "ToolChip (template only)" delegates the
chip template to F02 + F03. At HEAD a `ToolChip.vue` exists but
on the F05-legacy four-prop `presentation` signature; the
canonical eight-prop bag is owned by **F03 plan §2.1 + commit 5**
(see the F03 rebaseline). F05's only obligations are:

1. After F03 R2 lands the eight-prop bag, verify the chip body
   renders `callContent` / `resultContent` via `<JsonView>` or
   `<FormattedContent>` (design §1.6) and never re-tokenizes
   JSON inline.
2. Verify per-tool presenter call sites inside the chip body
   resolve through `getToolPresenter()` (no inline branching).

These verifications are spelled out as test assertions in F03 r3
§5 chip test cases; F05 contributes no new tests for this row.

F05 R1 (this batch) does **NOT** touch `ToolChip.vue`. That file
is F03 R2 territory.

### 3.4 Selector-migration tests touching presenter call sites

The test file co-committed with the F02 + F05 FilesView change
in §3.1:

- `web/src/__tests__/views/files-view.test.ts` — rewritten to
  query the canonical URL-driven panel via `data-testid`.

Test files for `AgentConversationView.vue` and
`AnalystChatPanel.vue` are F03 R2 / F04 R3 territory and not
covered here.

---

## 4. Reconciliation deliverables

### 4.1 `ToolCallPresentation` / `ToolResultPresentation` audit grep (after F03 R2)

After F03 R2 lands the eight-prop ToolChip bag (F03 rebaseline
§5.1), add the following grep to the F03 PR's full-suite gates
(not F05 R1's gates):

```sh
git grep -nE 'presentation:\s*Tool(Call|Result)Presentation' \
  web/src/components/ web/src/views/ | wc -l   # MUST be 0
```

Per-tool modules legitimately reference these types in their
exported `formatXxx(...)` signatures; that usage is in scope and
unflagged. F05 R1 contributes no code for this row; it is
documented here so the F02 + F03 implementers know the audit
exists.

### 4.2 No `formatToolPair` re-introduction

Design §1.6 + F05 r3 §4 forbid a shared `formatToolPair`. Audit
grep:

```sh
git grep -n 'formatToolPair\|FormattedToolPair' web/src/ | wc -l   # MUST be 0
```

Currently passes; this is a guard, not a remediation.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages cover every row in §3.1
   and §3.2 (per-tool test suite). No row may be silently
   dropped.
3. The FilesView routing change in §3.1 is co-committed with the
   F02 surface rewrite of `FilesView.vue` (F02 rebaseline r2
   §3.5 row C9). One stage, one commit; not split across
   mailbox cycles.
4. The per-tool test suite in §3.2 is a binding plan deliverable;
   not a future-work item. Deleting the legacy flat test file
   without creating the nested suite is a hard descope and
   forbidden.
5. If a precondition has shifted, file a delta proposal or
   reject via `.decision.md`.

---

## 6. Stage-mapping suggestion (non-binding)

F05 R1 merges into the F02 R1 batch's stage sequence:

- The §3.1 FilesView routing lands in F02 R1 Stage S4 (FilesView)
  as the F05 contribution to that commit.
- The §3.2 per-tool test suite + flat-file deletion lands as a
  dedicated stage at the start or end of F02 R1 (it is
  independent of every surface rewrite, so order is free).

There is no need for a separate F05 mailbox batch; the F05
remaining work fits inside the F02 R1 batch by virtue of the
foundation already being shipped. The single mailbox entry for
R1 cites both the F02 rebaseline and the F05 rebaseline as
binding contracts.
