# Review - F01 Design Tokens Analysis r1

Reviewer verdict: changes requested.

The analysis is directionally right: F01 should establish a dark semantic CSS layer before the UI port continues, and it correctly rejects a theme switcher, light-theme migration path, and dependency-heavy styling stack. The current draft is not yet safe to approve because several claims are internally inconsistent, and the proposed mapping would either fail its own validation gate or encode new semantics that do not match v2.

## 1. Clean Code / Clean Architecture

The four-layer target is a good architectural fit for the issue. [01-analysis-r1.md#L64-L71](01-analysis-r1.md#L64-L71) matches the subsystem map's intended port of v2's `tokens -> semantic -> base -> patterns` layering.

The inventory breaks that layering, though. [01-analysis-r1.md#L92-L107](01-analysis-r1.md#L92-L107) says raw color identities live in `tokens.css`, but [01-analysis-r1.md#L172-L186](01-analysis-r1.md#L172-L186) places new raw hex identities directly in `semantic.css` (`#1c2738`, `#1a2418`, `#241f18`, `#241818`, `#201a2e`). That makes the semantic layer both a naming layer and a second palette source, which is not clean architecture.

The migration section also mixes responsibilities. [01-analysis-r1.md#L252-L254](01-analysis-r1.md#L252-L254) says F01 deletes pattern re-implementations, annotates temporary duplication for F02, and also avoids template surgery. That is a muddy boundary: either F01 only introduces variables and performs mechanical color replacement, or it owns pattern-class adoption. Keeping temporary visual duplication with `F02` comments is project-management residue in code, not a clean design.

The proposed copy of `patterns.css` should be described exactly. [01-analysis-r1.md#L69-L69](01-analysis-r1.md#L69-L69) lists `.pulse`, but v2 defines only `@keyframes pulse`, not a `.pulse` class, in [../../../../../saivage/web/src/styles/patterns.css#L212-L215](../../../../../saivage/web/src/styles/patterns.css#L212-L215). That is small, but it undermines the claim that the inventory is mechanically verified.

## 2. Architecture-First, No Backward Compatibility

The draft mostly honors the rule by rejecting `--legacy-*`, fallbacks, `prefers-color-scheme`, theme stores, and switchers in [01-analysis-r1.md#L268-L271](01-analysis-r1.md#L268-L271) and [01-analysis-r1.md#L290-L297](01-analysis-r1.md#L290-L297). That part is aligned with the project guideline.

The exception is the temporary-duplication strategy in [01-analysis-r1.md#L252-L252](01-analysis-r1.md#L252-L252). Annotating code with `// F02:` while preserving duplicated visual rules is a compatibility shim in practice: it keeps the old component-local style system alive beside the new global one. The analysis should instead define a clean boundary that leaves no intentional dual system behind.

The future-light-theme paragraph is also slightly misleading. [01-analysis-r1.md#L79-L81](01-analysis-r1.md#L79-L81) says a future light theme would be a single `tokens-light.css` plus body class, while [01-analysis-r1.md#L292-L296](01-analysis-r1.md#L292-L296) rejects theme machinery. It is fine to say light is out of scope; do not sketch future switcher architecture unless the design explicitly owns that architecture.

## 3. Correctness

The semantic names do not match v2 one-for-one. The analysis claims they do in [01-analysis-r1.md#L142-L142](01-analysis-r1.md#L142-L142) and [01-analysis-r1.md#L266-L266](01-analysis-r1.md#L266-L266), but it adds `--text-strong` and `--entry-accent2-*` in [01-analysis-r1.md#L157-L186](01-analysis-r1.md#L157-L186). v2's semantic variables stop at `--text-faint` and do not have an accent-2 entry family, as shown in [../../../../../saivage/web/src/styles/semantic.css#L18-L29](../../../../../saivage/web/src/styles/semantic.css#L18-L29) and [../../../../../saivage/web/src/styles/semantic.css#L32-L44](../../../../../saivage/web/src/styles/semantic.css#L32-L44).

The new `--entry-accent2-*` semantics are especially wrong. [01-analysis-r1.md#L184-L186](01-analysis-r1.md#L184-L186) gives an "accent-2" slot red danger values for the auth strip. That should either be folded into `--entry-danger-*` or justified as a clearly named auth/danger semantic. Calling red auth-required styling "accent-2" collides with v2's `--accent-2`, which is the secondary accent/link family.

The mapping table is incomplete against the actual v3 codebase. It omits observed values such as `#1f2937` in [../../../../web/src/components/chat/AnalystChatPanel.vue#L307](../../../../web/src/components/chat/AnalystChatPanel.vue#L307), `#0d1c33` in [../../../../web/src/views/DashboardView.vue#L305](../../../../web/src/views/DashboardView.vue#L305), `#1a1f24` in [../../../../web/src/views/FilesView.vue#L298](../../../../web/src/views/FilesView.vue#L298), and `#1c2128` in [../../../../web/src/components/cards/CardsBoardView.vue#L187](../../../../web/src/components/cards/CardsBoardView.vue#L187). Those are not rare hypothetical values; they are live UI colors.

The mapping table also misclassifies at least one text color. [01-analysis-r1.md#L240-L240](01-analysis-r1.md#L240-L240) maps `#ffd8d3` to `--entry-danger-bg` / `--entry-danger-border`, but the current source uses it as auth-banner text in [../../../../web/src/components/layout/AppShell.vue#L212-L215](../../../../web/src/components/layout/AppShell.vue#L212-L215). Replacing a light danger text value with a background or border variable would be semantically wrong.

The user/assistant color semantics need a sharper decision. v2's `.entry-user` and `.entry-accent` are both green-family entries in [../../../../../saivage/web/src/styles/semantic.css#L32-L35](../../../../../saivage/web/src/styles/semantic.css#L32-L35), while the analysis maps blue tint values to `--entry-user-*` in [01-analysis-r1.md#L172-L175](01-analysis-r1.md#L172-L175) and [01-analysis-r1.md#L243-L243](01-analysis-r1.md#L243-L243). That may be appropriate for assistant/link strips, but it is not a faithful v2 semantic mapping unless the analysis explicitly redefines what "user entry" means in v3.

The dark palette is cohesive because it mostly follows GitHub Dark, but the draft does not prove contrast. [01-analysis-r1.md#L298-L298](01-analysis-r1.md#L298-L298) explicitly defers accessibility beyond spot checks. For a token analysis, it should at least include contrast checks for the high-traffic combinations: `--text` on `--bg`/`--surface-1`, `--text-muted` on dark surfaces, `--danger` on `--entry-danger-bg`, `--warn` on `--entry-warn-bg`, `--accent-2` on `--entry-user-bg`, and `--btn-primary-text` on `--btn-primary-bg`.

## 4. Completeness

The draft covers the v2 categories at a high level: surfaces, borders, text, accents, `entry-*`, `code-*`, `syn-*`, `btn-primary-*`, overlay, hover, and `--mono` are all present in [01-analysis-r1.md#L146-L216](01-analysis-r1.md#L146-L216). That is the right shape.

It still needs a mechanical v2-to-v3 inventory table. The source semantic set in [../../../../../saivage/web/src/styles/semantic.css#L7-L74](../../../../../saivage/web/src/styles/semantic.css#L7-L74) is small enough to list exactly. The analysis should show every v2 variable, its proposed v3 value, and whether it is unchanged, revalued, added, or removed. Right now "same names as v2" and "additions at the end" are prose claims that conflict with the actual snippet.

Pattern completeness also needs exactness. v2 pattern classes include `.entry-*`, `.card`, `.card-active`, `.btn`, `.btn-primary`, `.btn-danger`, `.pill`, `.pill-warn`, `.pill-accent`, `.pill-danger`, `.code-inline`, `.code-block`, `.syn-*`, `.panel-heading`, `.status-dot`, text utilities, `.overlay`, and `.spin` in [../../../../../saivage/web/src/styles/patterns.css#L8-L209](../../../../../saivage/web/src/styles/patterns.css#L8-L209). The analysis should copy that list, not a near-list.

The source checks should also account for `web/src/components/code` and `web/src/components/nav`, where current hex literals exist in [../../../../web/src/components/code/MarkdownText.vue#L55-L55](../../../../web/src/components/code/MarkdownText.vue#L55-L55), [../../../../web/src/components/code/CodeBlock.vue#L115-L168](../../../../web/src/components/code/CodeBlock.vue#L115-L168), and [../../../../web/src/components/nav/NavRail.vue#L91-L192](../../../../web/src/components/nav/NavRail.vue#L91-L192). The validation command includes `web/src/components`, so the implementation will catch them; the analysis examples should acknowledge them because code/highlight primitives are core to F01.

## 5. Testability

The presence of grep gates in [01-analysis-r1.md#L273-L278](01-analysis-r1.md#L273-L278) is good. The gates are not internally consistent.

Gate 2 says `web/src/styles` may contain hex only in `tokens.css`, but the proposed [01-analysis-r1.md#L172-L186](01-analysis-r1.md#L172-L186) `semantic.css` contains direct hex values. As written, the implementation would fail its own validation. Move all raw color hexes into `tokens.css`, derive semantic entries from raw tokens or documented rgba/color-mix expressions, or change the gate and explain why semantic literals are allowed.

Gate 1 says components and views must have no residual hex, but [01-analysis-r1.md#L85-L86](01-analysis-r1.md#L85-L86) states the stronger invariant "No hex literals in `web/src/**` outside `web/src/styles/`." Either the invariant or the command must be corrected. A stronger command should scan `web/src` and explicitly exclude known non-style test literals, such as the `#abc` / `#def` card ids in [../../../../web/src/__tests__/debug-store.supervision.test.ts#L63-L63](../../../../web/src/__tests__/debug-store.supervision.test.ts#L63-L63).

The gate should include tests, not just build. `pnpm -C web build` is necessary, but existing tests include source-level expectations and code/highlight behavior. At minimum, the analysis should require `pnpm -C web test` or a narrower documented test command if the full suite is intentionally out of scope.

The visual smoke list is useful, but it should be explicit about acceptance: no raw hex in rendered component CSS, no contrast regressions for auth/error/warn strips, no code-block background step, and no new scrollbar intrusion in the main scroll containers.

## 6. Transversal Impact

The analysis correctly calls out highlight.js, scrollbars, and snapshot churn in [01-analysis-r1.md#L282-L286](01-analysis-r1.md#L282-L286). Those are the right cross-cutting risks.

The highlight.js cascade reasoning is wrong. [01-analysis-r1.md#L71-L71](01-analysis-r1.md#L71-L71) imports `styles/index.css` before `github-dark.css`; [01-analysis-r1.md#L286-L286](01-analysis-r1.md#L286-L286) then says pattern classes win by source order. With equal specificity, the later `github-dark.css` wins, not the earlier index. If the desired result is "highlight wins for `.hljs-*`, local code-block shell wins for backgrounds," the analysis should state that precisely and define the specific override ordering.

The snapshot statement is also factually stale. [01-analysis-r1.md#L285-L285](01-analysis-r1.md#L285-L285) says there are no `__snapshots__` under `web/`, but the web test tree has an existing snapshots directory. The analysis can still conclude snapshot churn is likely low, but it should not rely on a false absence claim.

Scrollbar risk is adequately identified in [01-analysis-r1.md#L283-L283](01-analysis-r1.md#L283-L283). The missing piece is a validation target: name the scroll containers to smoke test, especially the app content, analyst chat, agent conversation, file browser, and code block overflow areas.

## 7. Over-Engineering

The draft avoids the largest over-engineering traps: no Tailwind, no CSS-in-JS implementation, no theme store, no persisted preference, no switcher, and no new dependencies in [01-analysis-r1.md#L270-L271](01-analysis-r1.md#L270-L271) and [01-analysis-r1.md#L292-L297](01-analysis-r1.md#L292-L297). Good.

The unnecessary primitives are the new semantic families and strong/light raw variants that are not yet justified by usage. `--entry-accent2-*` is the main one; `--text-strong` may also be unnecessary if headings can use `--text`, or if the analysis explicitly decides to add a v3-only text-emphasis semantic. The raw `--c-blue-strong`, `--c-yellow-light`, `--c-red-strong`, and `--c-purple-strong` tokens should either be mapped to real semantic uses or removed from the proposed initial set.

Do not introduce future theme structure as explanatory architecture. A short "dark-only; future theming intentionally out of scope" is cleaner than sketching a `tokens-light.css` / `data-theme` path.

## 8. Alternative Considered

This axis is missing. [01-analysis-r1.md#L270-L271](01-analysis-r1.md#L270-L271) and [01-analysis-r1.md#L296-L296](01-analysis-r1.md#L296-L296) reject CSS-in-JS, Tailwind, and PostCSS plugins, but they do not consider a one-conceptual-level-up alternative.

The revised analysis should include a brief alternative section. It can reject the alternative, but it should explicitly consider at least one of: a single `tokens.ts` source that generates CSS variables and typed Vue helpers, a CSS-in-JS layer for component primitives, or adopting an external token set such as Open Props. Given the issue's v2-port goal, the likely conclusion is still the four-file CSS pipeline, but the analysis must show that decision was deliberate.

## Nice-To-Haves

- Add a tiny generated or hand-maintained "v2 semantic var diff" table so future reviewers can quickly see additions and deletions.
- Prefer naming any v3-only semantics after meaning (`--auth-required-*`, `--text-danger-strong`, etc.) rather than color family, if additions survive the next round.
- Consider whether `base.css` should include `textarea` in the inherited-font reset for v3's analyst composer, even though v2 only resets `button` and `input`.

## Required Changes

1. Replace the prose "same names as v2" claim with an exact v2 semantic variable diff, and either remove or explicitly justify every v3-only semantic variable, especially `--text-strong` and `--entry-accent2-*`.
2. Fix the token/semantic layering so the proposed files satisfy the stated hex gate: raw hex identities must not appear in `semantic.css` if validation says only `tokens.css` may contain hex.
3. Correct the hex-to-variable mapping table against the actual v3 source, including the currently omitted values and the misclassified `#ffd8d3` auth-banner text color.
4. Resolve the F01/F02 boundary without temporary compatibility residue: no `// F02:` annotations or intentional dual visual systems left behind by F01.
5. Update the validation plan so its commands match the stated invariant, include the relevant web test command, and include explicit visual/contrast acceptance checks.
6. Correct the highlight.js cascade explanation and the snapshot-directory claim.
7. Add a real "alternative considered" section for a one-conceptual-level-up option and explain why the four-file CSS pipeline remains the selected design.
VERDICT: CHANGES_REQUESTED