# Review - F01 Design Tokens Analysis r2

Reviewer verdict: changes requested.

The r2 draft resolves most of the r1 critique. I verified the seven required items against the r1 review, v2 semantic/pattern styles, and the live v3 UI source.

## Required item verification

1. Exact v2 semantic variable diff: addressed. The first-column entries in section 3.3 match the actual left-hand declarations in `saivage/web/src/styles/semantic.css` exactly, with no missing v2 semantic variables and no extra v3-only variables. r2 also explicitly drops the r1 additions `--text-strong`, `--entry-accent2-border`, and `--entry-accent2-bg`.

2. `semantic.css` raw-hex layering: addressed. The proposed section 3.2 semantic snippet contains no raw hex literals. The values are expressed through `var(...)`, `rgba(...)`, or `color-mix(...)`, so the stated invariant that only `tokens.css` contains hex can be satisfied.

3. Hex audit against live v3 source: not fully addressed. I spot-checked previously missed values (`#1f2937`, `#0d1c33`, `#1a1f24`, `#1c2128`, `#ffd8d3`, `#5a2525`) and they are all live and correctly represented in section 3.4. However, a full distinct-value comparison over `web/src/components`, `web/src/views`, `web/src/App.vue`, and `web/src/main.ts` finds 51 distinct live hex values, while section 3.4 lists 50. The missing value is `#1a2418`, which r2 already reports in section 1 as the accent/green entry background but omits from the mapping table. It is live in success/running/done status surfaces such as `DebugView.vue`, `DashboardView.vue`, `AgentsView.vue`, `AgentConversationView.vue`, `CardDetailView.vue`, and `CardsTimelineView.vue`. This should map to the existing v2 slot `--entry-accent-bg` and the audit total should become 51/51.

4. F01/F02 boundary: addressed. r2 removes the r1 `// F02:` annotation strategy and states that F01 lands as one batch with no temporary dual visual system. Pattern-class adoption is cleanly deferred to F02 while F01 owns global variables, copied base/pattern files, and mechanical hex replacement.

5. Validation plan and contrast acceptance: addressed. The grep gate now scans `web/src` and excludes only `tokens.css` and test fixtures, `pnpm -C web test` is included, and visual acceptance names the relevant surfaces and scroll containers. The contrast table gives AA conclusions for the important text, entry, auth-banner, and button pairs. The only borderline row is `--text-faint`, and r2 constrains that to large/UI-only usage rather than treating it as normal body text.

6. Highlight.js cascade and snapshots: addressed. r2 correctly states that `github-dark.css` wins for `.hljs-*` token colors because it imports after `index.css`, then `highlight-overrides.css` wins only for the `pre.hljs` shell. It also corrects the snapshot-directory claim and includes tests in the gate.

7. Alternative considered: addressed. Section 8 is substantive, not boilerplate: it evaluates Open Props, a TypeScript token source/codegen path, and CSS-in-JS, then rejects each for reasons tied to the v2-port goal and project constraints.

## Nice-to-haves

- In the contrast table, change `borderline (large/UI only)` to an explicit phrase such as `fails AA normal text; passes AA large/UI`. The current prose is understandable and non-blocking, but that wording would be clearer.
- Recalculate the approximate contrast ratios after the final `color-mix()` percentages are chosen. The pass/fail conclusions look acceptable, but exact ratios should come from the final computed colours.

## Remaining required items

1. Add the missing live `#1a2418` row to section 3.4, map it to `--entry-accent-bg`, and update the distinct-value coverage claim from 50/50 to 51/51.

VERDICT: CHANGES_REQUESTED