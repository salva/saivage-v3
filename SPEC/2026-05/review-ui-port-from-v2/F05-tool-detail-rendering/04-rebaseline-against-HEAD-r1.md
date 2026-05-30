# F05 — Rebaseline against HEAD `eb98caf` (r1)

This is a **binding addendum** to the F05 approved artifacts:

- analysis: [01-analysis-r2.md](01-analysis-r2.md)
- design:   [02-design-r3.md](02-design-r3.md)
- plan:     [03-plan-r2.md](03-plan-r2.md)

The approved analysis and design are unchanged. This document
records which deliverables already exist on HEAD `eb98caf`, which
remain to land, and which need explicit reconciliation. A reader
who has never seen earlier review rounds can implement the
remaining F05 work by combining the approved design, the
approved plan, and this rebaseline.

The implementer MUST NOT recreate files listed in §2, MUST NOT
silently descope anything in §3 or §4, and MUST follow the
nothing-lost invariant in §5.

---

## 1. HEAD reference

- Commit: `eb98caf` (`master`).
- F05 landing commit (presenter registry + content layer):
  `feb442f` (mailbox-005-ui-port-f05-tool-detail-rendering).

The implementer MUST verify HEAD has not modified
`web/src/utils/tool-presenters/`, `web/src/utils/json-tokenize.ts`,
`web/src/components/content/`, or `web/src/views/FilesView.vue`
before starting. If those paths have changed, file a delta
proposal first.

---

## 2. Already-landed deliverables (NO-OP)

### 2.1 Tool-presenter registry

The full per-tool module split from plan §1.1 (analysis §3.1) is
shipped. Verified file count: 52 entries under
`web/src/utils/tool-presenters/`. Contains the barrel
`index.ts`, the registry, `types.ts`, `helpers.ts`,
`__default__.ts`, and one module per tool name listed in
analysis §3.1. Legacy `web/src/utils/tool-presenters.ts` is
deleted.

### 2.2 `json-tokenize.ts`

[web/src/utils/json-tokenize.ts](../../../../web/src/utils/json-tokenize.ts)
exports `tokenizeJson(value, opts?)` and (per F05 plan §1.1) the
helper used by `JsonView.vue`. Unit tests
`web/src/__tests__/utils/json-tokenize.test.ts` are present.

### 2.3 `InlinePart` discriminated union (design §3.2; plan §1.2)

`web/src/utils/tool-presenters/types.ts` line 3 declares the
`file` variant on the canonical shape:

```ts
| { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
```

This is the binding shape. No `name` field, no `pathPrefix` field.

### 2.4 Content components

`web/src/components/content/{JsonView,FormattedContent,InlineParts}.vue`
are landed (foundation also satisfies F02 §2.2).

### 2.5 Per-tool router migration

All call sites that previously branched on tool name have been
moved to `getToolPresenter(name)` per plan §1.3 C5 row. No
`if (toolName === ...)` branches remain in
`web/src/components/agents/AgentConversationView.vue` or
`web/src/components/chat/AnalystChatPanel.vue`.

---

## 3. Remaining deliverables (IN SCOPE)

### 3.1 FilesView canonical routing — plan §2 C9 + design §4

`web/src/views/FilesView.vue` still uses two separate panels
(`fetchMetaFiles` / `fetchOutputFiles`) with bespoke
`.panel-root` / `.panel-refresh-btn` selectors (see HEAD
[web/src/views/FilesView.vue:20](../../../../web/src/views/FilesView.vue#L20)
and following). The design contract is a single canonical
URL-driven view:

- Route shape: `/files?root=meta|output&path=<rel>`.
- Single panel listing whose data is selected from the URL
  (router-driven, not click-driven `metaFiles` vs `outputFiles`
  state).
- `<InlineParts>` links from elsewhere in the app (e.g. tool
  presenters returning `kind: 'file'` parts) navigate via
  `router.push({ path: '/files', query: { root, path } })` — see
  design §4.3.
- Bespoke selectors `.files-global-banner`, `.panel-root`,
  `.panel-refresh-btn`, `.panel-loading`, `.panel-empty`,
  `.panel-crumbs`, `.panel-card` are DELETED in the same commit
  (plan §2 C9 deletion list; F02 r2 §4.5 also lists them).
- The F02 surface rewrite of `FilesView.vue` (plan C9 in F02 r2)
  is co-committed with this routing change; see F02 rebaseline
  §3.5 row C9.

### 3.2 `ToolChip.vue` template — plan §1.3 row "ToolChip (template only)"

The F05 plan §1.3 row delegates the ToolChip template to F02
(prop bag) and F03 (chrome). At HEAD a `ToolChip.vue` exists but
on the F05-legacy four-prop signature; the canonical eight-prop
bag (design §1.6 + F03 r3 §3.2 + F04 r2 §4.1) is NOT yet wired.

The replacement is owned by **F02 rebaseline §4.2**. F05's only
obligations are:

1. Verify, in the same commit that lands the eight-prop bag,
   that the per-tool presenter call sites inside the chip body
   resolve through `getToolPresenter()` (no inline branching).
2. Verify the chip body renders `callContent` / `resultContent`
   via `<JsonView>` or `<FormattedContent>` (design §1.6) and
   never re-tokenizes JSON inline.

These verifications are spelled out as test assertions in F03 r3
§5 chip test cases; F05 contributes no new tests for this row.

### 3.3 Selector-migration tests touching presenter call sites

Every test file that exercises a tool-presenter call path AND
uses bespoke selectors (analysis §5.4 row "tool-presenter call
sites") MUST be migrated to `data-testid=` queries in the same
commit as the surface rewrite that owns it. List:

- `web/src/__tests__/views/files-view.test.ts` — paired with
  plan C9 above.
- `web/src/__tests__/components/agents/agents-view.test.ts` —
  paired with F02 plan C11.
- `web/src/__tests__/components/chat/analyst-chat-panel.test.ts`
  — paired with F02 plan C13 + F03 round-timeline rewrite.

---

## 4. Reconciliation deliverables (replace shipped-with-wrong-shape)

### 4.1 `ToolCallPresentation` / `ToolResultPresentation` consumer split

`tool-presenters/types.ts` still exports the two presentation
shapes. They remain the **per-tool presenter return types**
(legitimate). The chip-side `presentation` legacy API on
`ToolChip.vue` must NOT be reintroduced. After the F02 §4.2
rewrite lands, run a grep gate (added to plan §3 full-suite
gates):

```
git grep -nE 'presentation:\s*Tool(Call|Result)Presentation' \
  web/src/components/ web/src/views/ | wc -l   # MUST be 0
```

Per-tool modules legitimately reference these types in their
exported `formatXxx(...)` signatures; that is in scope and not
flagged.

### 4.2 No `formatToolPair` re-introduction

Design §1.6 + F05 r3 §4 forbid a shared `formatToolPair`
abstraction. Verify by:

```
git grep -n 'formatToolPair\|FormattedToolPair' web/src/ | wc -l   # MUST be 0
```

Currently passes; this is a guard, not a remediation.

---

## 5. Nothing-lost invariant (binding)

The harness MUST:

1. Read this rebaseline plus [02-design-r3.md](02-design-r3.md)
   and [03-plan-r2.md](03-plan-r2.md).
2. Produce a stage-plan whose stages, taken together, cover
   every row in §3 and §4. No row may be silently dropped or
   narrowed.
3. The FilesView routing change in §3.1 is co-committed with the
   F02 surface rewrite of `FilesView.vue` (F02 rebaseline §3.5
   row C9). The two are one stage, one commit; they cannot be
   split across mailbox cycles.
4. If a precondition has shifted (e.g. routing infrastructure
   changed), file a delta proposal naming §3.1 explicitly, OR
   reject the batch via `.decision.md` naming the row that
   would be lost.

---

## 6. Stage-mapping suggestion (non-binding)

F05 remaining work fits into the F02 rebaseline's Stage S4
("FilesView") plus a verification step in Stage S1 for the chip
body. There is no need for a separate F05 stage; F05 has merged
into the F02 sequence by virtue of the foundation already being
shipped.
