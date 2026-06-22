# F05 — Tool detail rendering: Plan review (R1)

Reviewer round 1 for [03-plan-r1.md](03-plan-r1.md), checked against approved design [02-design-r3.md](02-design-r3.md), approved analysis [01-analysis-r2.md](01-analysis-r2.md), and sibling implementation plans F02/F03/F04 r1.

## Verdict summary

Approved. The plan is implementation-ready in the places that matter: it deletes the old single-file presenter without a shim, creates the self-registering per-tool registry, preserves the side-effect import story, gives the consumers only the InlinePart data-flow migration owned by F05, and leaves the actual chip swap to F03. The remaining issues below are coordination / wording fixes, not blockers.

## Review notes

### 1. Per-tool file scaffolding commit completeness

PASS with a cleanup note. C2 introduces the directory layout, barrel, helpers, registry, default presenter, and a stub file per tool; C3 then fills each per-tool module with exactly one registration. The explicit C3 table includes the approved design's full tool matrix, including `diff_card`.

Non-blocking correction: the plan repeatedly says **45** per-tool files/tests, but design r3 `EXPECTED_TOOL_NAMES` lists **46** named tools:

- C2: "Forty-five stub files in total".
- C3: "45 files + __default__" / "45 per-tool files".
- C7 and summary tables: "45 test files", `<each-of-45-tools>`, `× 45 + __default__`.

The explicit table/list is complete, and the coverage test is specified to use design r3 §3.6, so this is not a functional blocker. Still, every count should be changed to 46 before implementation to avoid one skipped scaffold or one missing test file.

### 2. Single deletion of old `tool-presenters.ts` with no re-export shim

PASS. C2 deletes `web/src/utils/tool-presenters.ts` in the same commit that introduces `web/src/utils/tool-presenters/index.ts`; §4.3 reiterates no re-export shim. The plan also normalizes any explicit `.ts` imports and deletes the old string-headline test file in C7 rather than leaving a compatibility layer.

The F02 plan also claims ownership of the same physical deletion in its C4. F05 handles this by declaring F05 C2 to be the same physical commit as F02 C4, which is the right coordination model.

### 3. ESLint `no-restricted-imports` coverage

PASS with one suggested hardening. C6 covers production consumers under `web/src/**/*.{ts,vue}`, excludes the internal registry directory and tests, and rejects deep imports such as `utils/tool-presenters/registry`, `helpers`, `__default__`, and per-tool files. That is the right enforcement boundary: app code gets the barrel; tests may reach `_registryKeysForTest` from `registry`.

Suggested non-blocking hardening: add an explicit grep gate in C6 / PR validation for both forbidden shapes:

- `utils/tool-presenters/` deep imports outside `web/src/__tests__` and `web/src/utils/tool-presenters`.
- explicit `utils/tool-presenters.ts` imports.

The deleted file makes the `.ts` suffix fail typecheck already, but the grep gate would make the rule's intent visible and keep future edits honest.

### 4. `sideEffects` manifest commit

PASS for F05. C2 adds the package-relative manifest entry exactly as approved in design r3:

```json
"sideEffects": [
  "src/utils/tool-presenters/**/*.ts",
  "*.css"
]
```

Coordination note: F02 plan r1 still mentions `"./web/src/utils/tool-presenters/**"` in its C4 text. Because F05's C2/F02's C4 are declared to be the same physical commit, the implementer should treat F05 design r3 / this F05 plan as authoritative for the manifest glob and not copy the stale F02 wording.

### 5. Consumer migration commit and chip-swap ownership

PASS. C8 limits F05 to the presenter/data-flow migration in `AgentConversationView.vue` and `AnalystChatPanel.vue`: `InlinePart[]` headlines/details, `<InlineParts>`, and `<FormattedContent>`. It explicitly does **not** replace the analyst surface with shared `<ToolChip>`; F03 owns that swap and deletion of the legacy `.tool-chip*` wrappers/CSS.

That matches the requested boundary and avoids duplicating the F03 chip-swap work. The C9 contract-only chip shell is acceptable as a fallback if F05 lands before F03, as long as F03 treats it as an existing file to layer on rather than creating a second chip implementation.

### 6. Tests

PASS. The test plan covers the important seams:

- JSON tokenization and content rendering: `json-tokenize`, `JsonView`, `FormattedContent`.
- Inline part rendering/routing: `InlineParts.test.ts` includes `meta` and `output` file links, URL attributes, code/text rendering, tone classes, and display truncation not changing the route target.
- Files view query handling: explicit `root=meta|output`, no bare `?path` fallback, unrecognized roots ignored, watcher covers both keys.
- Registry integrity: coverage test for exact expected names, barrel-integrity test for bare imports and `__default__` last, registry test for fallback/error behavior.
- Per-tool behavior: one file per tool plus `__default__`, structured `InlinePart[]` assertions only.
- ARIA/DOM and raw-content routing: F05-owned `ToolChip.test.ts` cases assert the eight-prop bag, single toggle button, non-button group root, sibling links, details id wiring, and `<FormattedContent>` receiving `callContent` / `resultContent` rather than presentations.

Non-blocking clarification: because C8 intentionally leaves the old consumer wrappers in place until F03, the ARIA/DOM claims should be described as protecting the shared `ToolChip` contract, not as proving the pre-F03 consumer surfaces have already removed their legacy wrappers. The plan mostly says this, but the validation prose should avoid implying F05 standalone has completed the chip DOM migration.

### 7. Cross-issue dependencies

PASS. The dependency story is coherent:

- F02 owns component/content/conversation folder taxonomy and code-to-content relocation; F05 can create `content/` if it lands first, but the metaplan should still sequence F02 before F05.
- F05 owns the presenter registry, InlinePart contract, content renderers, FilesView query schema, side-effects manifest, and chip prop-bag contract.
- F03 owns the actual shared `ToolChip`, round integration, `toolChipPropsFor`, and analyst in-place chip swap.
- F04 consumes the F03/F05 chip adapter contract during decomposition and must not patch around missing upstream pieces.

The only cross-plan drift I would fix before handing this to an implementer is the stale F02 `sideEffects` glob and the 45/46 count typo. Neither changes the architecture or commit sequence.

VERDICT: APPROVED