# F04: CardStore Is a 750-Line God Class

**Severity:** HIGH  
**Transversality:** LOCAL  
**Category:** Tangled responsibilities  
**Verdict:** SOUND — confirmed at `src/cards/card-store.ts`

## Summary

`CardStore` handles boot recovery, read APIs, creation and validation, evidence refs and notification queuing, reordering, lifecycle status construction, deletion, subtree archive/delete, compaction internals, and patch persistence. At least six distinct concerns should be separate modules.

## Corrected Evidence

- `src/cards/card-store.ts:138-193` — Boot recovery and temp cleanup
- `src/cards/card-store.ts:241-323` — Read APIs
- `src/cards/card-store.ts:327-381` — Creation and validation
- `src/cards/card-store.ts:392-456` — Evidence refs and notification queuing
- `src/cards/card-store.ts:525-588` — Lifecycle status construction (should be in `lifecycle.ts`)
- `src/cards/card-store.ts:622-675` — Subtree archive and delete

Overstatement corrected: some lifecycle logic is already delegated to `lifecycle.ts` for transition validation and card construction. The issue is that the facade still orchestrates too many domains.

## Clean Architecture Approach

Keep `CardStore` as a facade over focused command objects: `CardReader`, `CardLifecycleCommands`, `CardHierarchyCommands`, `CardArchiveService`, and `EvidenceRefService`. Do not preserve the class shape for backward compatibility.