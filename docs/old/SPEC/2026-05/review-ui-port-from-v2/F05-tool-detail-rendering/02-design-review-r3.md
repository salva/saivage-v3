# F05 - Tool detail rendering: Design Review (R3)

Reviewer round 3 for [02-design-r3.md](02-design-r3.md). Inputs checked:

- New draft: [02-design-r3.md](02-design-r3.md)
- Previous critique: [02-design-review-r2.md](02-design-review-r2.md)
- Previous draft: [02-design-r2.md](02-design-r2.md)
- Approved analysis: [01-analysis-r2.md](01-analysis-r2.md)
- Current v3 presenter catalogue: [../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts)
- Sibling chip contracts spot-checked: [../F02-component-hierarchy/02-design-r2.md](../F02-component-hierarchy/02-design-r2.md), [../F03-conversation-rounds/02-design-r2.md](../F03-conversation-rounds/02-design-r2.md), [../F04-chat-surface-style/02-design-r2.md](../F04-chat-surface-style/02-design-r2.md)

## Required R2 Item Audit

| R2 required item | R3 status | Review notes |
| --- | --- | --- |
| 1. Cross-document chip contract alignment: canonical eight-prop bag, F02 six-prop snippets and `*Raw` names superseded, offending F02 sites identified. | PASS | R3 republishes the eight-prop contract in §4.1 with `callContent` / `resultContent`, declares the stale F02 §1.3.14 and §3 snippets non-binding errata in §4.4, and names the `callContentRaw` / `resultContentRaw` prose as forbidden. F02 r2 itself remains stale, but F05 r3 now gives an unambiguous binding contract and requires F02 r3 / implementation to use it. |
| 2. Fix source-link relative depth from the F05 directory. | PASS | R3 source citations use `../../../../web/...`, which is the correct four-segment path from this file to repo-root `web/`. I found no remaining `../../../web/...` source citations. |
| 3. Standardise the `sideEffects` path wording. | PASS | R3 consistently uses the package-relative `src/utils/tool-presenters/**/*.ts` glob for `web/package.json`; the earlier `./web/src/utils/tool-presenters/**` wording is gone. |

## Carry-Forward Audit

| Earlier item | R3 status | Review notes |
| --- | --- | --- |
| Remove `registerAlias` / `ALIASES`; use shared factories and direct registrations. | PASS | The registry API remains a flat `registerToolPresenter(name, presenter)` map. Shared behaviour is modeled through factories such as `makeReadFilePresenter`, `makeRunCommandPresenter`, and the card/runtime helper families. |
| Keep raw payload ownership on `<ToolChip>`, not presentations. | PASS | `ToolCallPresentation` and `ToolResultPresentation` remain structured summary outputs only; raw payloads flow through the chip props `callContent` and `resultContent`. |
| Single canonical public import path and delete the old file. | PASS | R3 keeps `web/src/utils/tool-presenters/index.ts` as the public entrypoint and explicitly deletes the old [../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts) file without a compatibility shim. |
| Registry initialization / tree-shaking story. | PASS | The barrel-only import rule, bare side-effect imports, `sideEffects` manifest, `assertDefault()` guard, and registry/barrel tests are all still specified. |
| Per-tool matrix reconciled against current v3 source. | PASS | The R3 matrix and `EXPECTED_TOOL_NAMES` cover the current call catalogue in [../../../../web/src/utils/tool-presenters.ts](../../../../web/src/utils/tool-presenters.ts), including `load_skill`, `mcp_tool_call`, card history tools, and `diff_card`. Command result detail is `process <pid>`, matching the current source, not stdout tail. |
| Browser-facing seam tests. | PASS | R3 preserves and sharpens the tests for `ToolChip`, `InlineParts`, `FilesView` query handling, registry/barrel integrity, per-tool presenters, and agent/analyst integration. The added negative cases for `callContentRaw` / `resultContentRaw` protect the r2 blocker. |

## Findings

No blocking findings.

The only residual coordination item is outside F05's document body: F02 r2 still physically contains the stale six-prop snippets and `*ContentRaw` prose. R3 handles that by declaring binding errata and requiring F02 r3 / implementation to replace them, which is enough for F05 approval because implementers now have a single canonical contract in §4.1.

## Recommendation

R3 addresses every required item from the R2 critique and keeps the previously approved presenter architecture intact. The design is ready to move into implementation planning, with the F02 cleanup tracked as a sibling-doc follow-up rather than another F05 blocker.

VERDICT: APPROVED