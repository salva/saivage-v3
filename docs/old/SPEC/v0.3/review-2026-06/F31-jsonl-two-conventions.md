# F31: JSONL Ledger Has Two Incompatible Append Conventions

**Severity:** LOW  
**Transversality:** LOCAL  
**Category:** Bad data abstraction  
**Verdict:** PARTLY SOUND — two conventions exist; raw convention is documented and intentional

## Summary

`JsonlLedger` wraps records in version envelopes, but `appendSyncIdempotent` (used for card history) does not. Card diary entries can silently degrade on read failures — `getDiaryEntries` skips missing entries and `getReviewAssessments` fabricates synthetic objects with empty values.

## Corrected Evidence

- `src/persistence/jsonl-ledger.ts:39-56` — Version-enveloped `appendSync`
- `src/persistence/jsonl-ledger.ts:180-251` — Raw `appendSyncIdempotent`/`appendSyncIdempotentByKey`
- `src/persistence/jsonl-ledger.ts:140-142` — Explicit comment that card history uses raw convention
- `src/cards/diary.ts:190-204` — Silent skip on missing entries
- `src/cards/diary.ts:297-323` — Fabrication of fallback review assessments

Overstatement corrected: the raw convention is explicitly documented at line 140-142 as intentional. The two conventions serve different purposes. The real issues are silent data degradation and O(file_size) `lastLineSync`.

## Clean Architecture Approach

Separate `VersionedJsonlLedger` and `RawJsonlLedger` modules with explicit semantics. Make diary/review read failures explicit errors or typed degraded records, not silent omissions or fabrications. Consider an indexed append format for large history files.