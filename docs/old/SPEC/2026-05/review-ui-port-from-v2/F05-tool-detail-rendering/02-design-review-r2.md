# F05 - Tool detail rendering: Design Review (R2)

Reviewer round 2 for [02-design-r2.md](02-design-r2.md). Inputs checked:

- New draft: [02-design-r2.md](02-design-r2.md)
- Previous critique: [02-design-review-r1.md](02-design-review-r1.md)
- Previous draft: [02-design-r1.md](02-design-r1.md)
- Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
- Chip-contract siblings: [SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/02-design-r2.md](../F02-component-hierarchy/02-design-r2.md), [SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/02-design-r2.md](../F03-conversation-rounds/02-design-r2.md), [SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/02-design-r2.md](../F04-chat-surface-style/02-design-r2.md)
- Current v3 presenter catalogue: [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)

## Required R1 Item Audit

| R1 required item | R2 status | Review notes |
| --- | --- | --- |
| 1. Remove `registerAlias` / `ALIASES`; use shared factories and direct registrations. | PASS | F05 r2 removes the alias subsystem from Proposal B, requires direct `registerToolPresenter(name, makeXPresenter(...))` calls, and keeps `_registryKeysForTest()` as a flat tool-name list. The remaining uses of the word "alias" are only in the review coverage prose and negative tests, not in the proposed runtime API. |
| 2. Define raw-content ownership and align the chip prop bag. | FAIL | F05 r2 itself is correct: presentations stay pure, and raw payloads live on `callContent` / `resultContent` in [02-design-r2.md](02-design-r2.md#L658-L675). F03 r2 and F04 r2 also use the eight-prop bag: [SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/02-design-r2.md](../F03-conversation-rounds/02-design-r2.md#L887-L993), [SPEC/2026-05/review-ui-port-from-v2/F04-chat-surface-style/02-design-r2.md](../F04-chat-surface-style/02-design-r2.md#L1104-L1211). However, the required F02 sibling still publishes stale six-prop `ToolChip` final-API snippets at [SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/02-design-r2.md](../F02-component-hierarchy/02-design-r2.md#L494-L538) and [SPEC/2026-05/review-ui-port-from-v2/F02-component-hierarchy/02-design-r2.md](../F02-component-hierarchy/02-design-r2.md#L1058-L1075), while also referring to non-existent `callContentRaw` / `resultContentRaw` variables. The design set is therefore still not aligned on the chip contract the implementation would typecheck against. |
| 3. Pick one canonical public import path and delete the old file. | PASS | R2 makes `web/src/utils/tool-presenters/index.ts` the public surface, keeps consumers on `../../utils/tool-presenters`, and deletes [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts) in the same change set. No compatibility re-export remains. |
| 4. Close the registry initialization / tree-shaking story. | PASS | R2 adds a barrel-only production import rule, bare side-effect imports, a `sideEffects` manifest entry, an `assertDefault()` runtime guard, `registry.test.ts`, and `barrel-integrity.test.ts`. The per-tool tests import the canonical barrel instead of individual tool files. |
| 5. Reconcile the per-tool matrix against current v3 source. | PASS | R2 uses the current call-side catalogue in [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts#L102-L177), includes the tools that currently fall through the old result fallback, and fixes the command-result contradiction: current `run_project_command` result detail is the process id in [web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts#L231-L242), not a stdout tail. The coverage test now asserts exact expected names plus both call and result presenters for every expected tool. |
| 6. Add browser-facing seam tests. | PASS | R2 names `ToolChip` ARIA/DOM tests, `InlineParts` routing tests, `FilesView` route tests, registry/barrel tests, and agent/analyst integration checks. These cover the seams the R1 review called out. |

## Blocking Finding

### 1. The required sibling chip contract is still inconsistent

The F05 draft correctly adopts the eight-prop raw-content contract, and it matches F03/F04. But the user explicitly asked this review to check F02/F03/F04 chip prop alignment, and F02 r2 still contradicts the chosen contract in two places:

- The F02 `conversation/ToolChip.vue` "final API" snippet omits `callContent: string` and `resultContent: string | null`, even though the body prose below it claims the expanded detail renders raw call/result content.
- The F02 consolidated prop-interface section repeats the same six-prop signature.
- F02's prose uses `callContentRaw` / `resultContentRaw`, names that do not exist in F03 r2, F04 r2, or F05 r2.

This is not a cosmetic doc mismatch. The implementation sequence says F02 owns the final `ToolChip` API while F03 ships the component and F04 binds it through `v-bind`. If an implementer follows the F02 final API, the F03/F04/F05 snippets will not typecheck and the expanded `<FormattedContent>` body has no source payload.

Required change: update F02 r2's `ToolChip` final API and consolidated prop-interface snippets to the same eight-prop bag used by F03/F04/F05:

```ts
{
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: ToolPairStatus;
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}
```

Also rename F02's prose references from `callContentRaw` / `resultContentRaw` to `callContent` / `resultContent`, or remove that prose and point directly to F03 r2 section 7.2 as authoritative.

## Non-blocking Corrections

- Several source links in F05 r2 point to `../../../web/...`; from the F05 directory the correct relative path to repo-root `web/` is `../../../../web/...`. The current review did not make this a blocker because the design content was verifiable from the actual source, but the links should be fixed before implementation planning.
- The coverage-map prose says the package manifest marks `./web/src/utils/tool-presenters/**` as side-effectful, while the later `web/package.json` snippet correctly uses `src/utils/tool-presenters/**/*.ts`. Prefer the latter wording everywhere to avoid path ambiguity.

## Recommendation

R2 fixes the substantive F05 registry, raw-payload ownership, import-surface, initialization, matrix, and test-plan issues from the R1 critique. The remaining blocker is cross-document contract alignment, not the presenter architecture itself. Once the stale F02 chip API snippets are brought into the same eight-prop contract, this design should be approvable without another broad rewrite.

VERDICT: CHANGES_REQUESTED
