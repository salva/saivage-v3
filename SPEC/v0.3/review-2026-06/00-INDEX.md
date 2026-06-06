# Saivage v3 Architectural Review — Issue Index

Generated: 2026-06-06  
Validated: 2026-06-06

## Implementation Authority

`00-METAPLAN.md` and `wave-*/PLAN.md` are the implementation authority. The `F01`-`F35` issue files are validated provenance: they explain the original findings, evidence, and initial repair direction, but later wave-plan review may supersede specific recommendations. If an issue file conflicts with the metaplan or a wave plan, follow the metaplan/wave plan and update the issue file only as a documentation cleanup.

Before starting any wave, run the relevant inter-wave consistency gate in `00-METAPLAN.md`. If landed code differs from the wave plan, edit the wave plan body directly; do not add separate review blocks.

| ID | Issue | Verdict | Severity | Transversality | Category |
|----|-------|---------|----------|----------------|----------|
| F01 | AgentAdapter invokeAgent is a 610-line method | SOUND | HIGH | CROSS-CUTTING | Tangled responsibilities |
| F02 | Analyst path duplicates LLM orchestration | PARTLY SOUND | HIGH | ARCHITECTURAL | Duplication of concerns |
| F03 | CardStore.refreshState() re-scans all cards | SOUND | HIGH | LOCAL | Bad data representation |
| F04 | CardStore is a 750-line god class | SOUND | HIGH | LOCAL | Tangled responsibilities |
| F05 | Four directory fsync duplications + multiple atomic-write patterns | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Duplication |
| F06 | Phase effects interfaces overlap but are not identical | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Missing abstractions (partial) |
| F07 | Runtime state arrays grow without bounds | SOUND | MEDIUM | CROSS-CUTTING | Bad data representation |
| F08 | Dual auth system (Fastify plugin + contract runtime) | SOUND | MEDIUM | ARCHITECTURAL | Tangled code |
| F09 | Web imports backend source via ../../../src/ paths | SOUND | HIGH | ARCHITECTURAL | Bad abstraction boundary |
| F10 | Tool dispatch duplicated across three paths | PARTLY SOUND | HIGH | ARCHITECTURAL | Duplication / Missing abstraction |
| F11 | WebSocket handler overloaded | SOUND | MEDIUM | LOCAL | Tangled code |
| F12 | ProjectLock has no stale-lock recovery | SOUND | MEDIUM | LOCAL | Bad data representation |
| F13 | MCP Manager monolith with distributed state | PARTLY SOUND | MEDIUM | LOCAL | Missing abstractions (partial) |
| F14 | Frontend god stores mix multiple domains | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Tangled code |
| F15 | Repetitive operator API contract boilerplate | PARTLY SOUND | MEDIUM | LOCAL | Duplication |
| F16 | Over-decomposed file structure with re-export barrels | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Over-engineering |
| F17 | Utility duplications (now, valuesEqual, redaction) | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Duplication |
| F18 | Planning blockers use substring matching | SOUND | MEDIUM | LOCAL | Bad data representation |
| F19 | Frontend sync has 3-layer redundancy | PARTLY SOUND | MEDIUM | LOCAL | Over-engineering |
| F20 | Two pause/resume paths (offline vs live) | PARTLY SOUND | MEDIUM | LOCAL | Duplication |
| F21 | Config schema mixes schema, loading, migration, defaults | SOUND | MEDIUM | LOCAL | Multi-purpose abstraction |
| F22 | Frontend stale-data race conditions | PARTLY SOUND | MEDIUM | LOCAL | Missing abstraction |
| F23 | Three compaction approaches, no shared strategy | PARTLY SOUND | MEDIUM | CROSS-CUTTING | Duplication |
| F24 | Cards state mixes I/O, validation, and read model | SOUND | MEDIUM | LOCAL | Tangled code / Bad abstraction |
| F25 | ProcessRunner global map and class-function indirection | PARTLY SOUND | MEDIUM | LOCAL | Bad data representation |
| F26 | Agent setter injection creates hidden init order | PARTLY SOUND | MEDIUM | LOCAL | Missing abstraction / Hidden coupling |
| F27 | LLM transport mixes OAuth, credential, and provider concerns | SOUND | MEDIUM | LOCAL | Tangled code |
| F28 | Content supervisor writes to disk on every pass | SOUND | LOW | LOCAL | Unneeded feature |
| F29 | Heuristic scanner is 573 lines of inline patterns | PARTLY SOUND | LOW | LOCAL | Bad data representation |
| F30 | Card ID generation is predictable and O(n) | PARTLY SOUND | LOW | LOCAL | Bad data representation |
| F31 | JSONL ledger has two append conventions | PARTLY SOUND | LOW | LOCAL | Bad data abstraction |
| F32 | Agent loop has no per-iteration timeout | PARTLY SOUND | LOW | LOCAL | Missing abstraction |
| F33 | Stuck agent supervisor is 560 lines of latent feature | SOUND | LOW | LOCAL | Over-engineering / Dormant |
| F34 | Contracts module contains misplaced runtime logic | PARTLY SOUND | LOW | LOCAL | Misplaced concerns |
| F35 | Diagnostic call-site duplication | PARTLY SOUND | LOW | CROSS-CUTTING | Duplication |

## Summary

- **SOUND**: 14 issues (F01, F03, F04, F07, F08, F09, F11, F12, F18, F21, F24, F27, F28, F33)
- **PARTLY SOUND**: 21 issues (F02, F05, F06, F10, F13-F17, F19-F20, F22-F23, F25-F26, F29-F32, F34-F35)
- **UNSOUND**: 0 issues

## Key Corrections from Validation

| ID | Original Claim | Correction |
|----|---------------|-----------|
| F02 | "Duplicates entire LLM transport stack" | Only duplicates orchestration/session/tool-loop; reuses LlmProviderGateway, transport config, and exchange recording |
| F05 | "Five duplicated fsyncDirectory implementations" | Four direct implementations; quarantine uses writeFileAtomic, not inline fsync |
| F06 | "Identical effects interfaces" | Interfaces differ in domain-specific methods; only partial overlap |
| F10 | "Three identical tool dispatch paths" | Planner-control tools have genuine domain-specific semantics |
| F14 | "Shared loading/error in all stores" | analystChat has separate session/message/send state; debug and cards have partial domain-specific state |
| F15 | "~1500 lines of boilerplate across 8 files" | ~900 lines across 10 files; routes don't heavily use the `permissions` field |
| F19 | "Vue reactivity gap" | SyncClient copies into real Vue refs; gap is mostly mitigated |
| F20 | "Nearly identical codepaths" | Live path adds lifecycle flags, process buffering, planner context, notifications, tick; offline delegates to live when available |
| F22 | "All store fetch methods" | Some stores have per-entity guards (llmExchangeSessionId, separate history state) |
| F23 | "Three full compaction mechanisms" | Analyst code is boundary cleanup, not budget-tracking compaction |
| F29 | "Cannot test patterns independently" | PATTERNS_BY_CATEGORY is exported; patterns are testable |
| F30 | "Non-unique under concurrent creation" | ProjectLock serializes mutations; collision leads to rejection, not corruption |
| F31 | "Two incompatible conventions" | Raw convention is documented and intentional |
| F35 | "Double diagnostic logging" | Two channels serve different purposes (bus vs. durable log); the issue is call-site responsibility split |

## Execution Frame

The implementation sequence is maintained in `00-METAPLAN.md`, not in this issue index. The current wave structure is:

1. **Wave 1:** F05, F12, F17, F31 — persistence and utility primitives.
2. **Wave 2:** F03, F24, F30 — card data model.
3. **Wave 3:** F09, F08, F34 — architecture boundaries.
4. **Wave 4:** F02, F10, F20, F23, F35 — path unification.
5. **Wave 5:** F01, F04, F13, F14+F22, F11 — decomposition.
6. **Wave 6:** F06, F07, F15, F16, F18, F19, F21, F25, F26, F27, F28, F29, F32, F33 — targeted fixes and cleanup.

Do not infer implementation ordering from severity alone. Follow the dependency graph and gates in `00-METAPLAN.md`.
