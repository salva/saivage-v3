# Expected breakage ledger

This file is the cumulative expected-breakage record for the analyst-as-control-surface migration. At close time, each stage appends entries for its own NEW failures relative to baseline-gates.json when the legitimate fix belongs to a later stage, and each stage removes entries whose `Target fix stage` is itself when the underlying failure is no longer observed.

## Entry shape

- A markdown heading at H3 level naming the failing artifact, in the exact form `### <failing-id>` where `<failing-id>` is one of the normalized strings from the snapshot.
- `Failure mode`: one sentence describing the symptom.
- `Reason acceptable now`: which SPEC-r7 requirement or earlier-stage decision forces it.
- `Target fix stage`: the id of a strictly later stage from the dependency DAG in the master plan (one of `S01`..`S10`; `S00` is not valid).
- `Recorded by`: the stage id and ISO-date that authored the entry.

## Open entries

### analyst-e2e:scenario-analyst-chat-context-child-order:step-1
Failure mode: the analyst chat panel renders the current card's children in client-sorted order; an e2e checker that shuffles the backend order observes a mismatch.
Reason acceptable now: `AnalystChatPanel` and its descendants are owned by S08 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S08 to flip the consumer.
Target fix stage: S08
Recorded by: S03 / 2026-05-25
