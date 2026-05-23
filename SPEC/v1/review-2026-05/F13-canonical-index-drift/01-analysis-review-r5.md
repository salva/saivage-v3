# F13 - r5 Review

## Analysis

No blocking issues.

The r4 create-row blocker is resolved. [01-analysis-r5.md](01-analysis-r5.md) makes `create` a baseline-only write: no public history row, no seq-0 fixture/ledger/schema path, `history/0` and `diff?from=0` remain rejected, and `version_seq` stays strictly positive. The pre-mutation history semantics are now consistent across the invariant, semantics table, deleted-card visibility, schema fanout, and live-probe expectations.

The `entry_id` / `kind` contract is concrete enough for implementation. Row-producing kinds require both fields, `create` is excluded from `CardHistoryKind`, and the analysis keeps the websocket envelope separate from the durable row without weakening the disk invariant.

Non-blocking note: the analysis says the existing `z.lazy(...)` wrapper is "preserved only as the exported alias," while [03-plan-r5.md](03-plan-r5.md) drops it in favor of a concrete base object. The plan's version is mechanically correct against the current validators shape, so this wording does not block approval.

## Design

No blocking issues.

The locking model now matches the real [src/persistence/project-lock.ts](../../../src/persistence/project-lock.ts) API: `ProjectMutex.lock()` is outer, `projectLock.withLock(async (handle) => ...)` is inner, and persistence code receives the `LockHandle` for `assertOwns(handle)`. The release order is correct: `withLock` releases the cross-process lock first, the outer `finally` releases the in-process mutex second, and `card_history_appended` is emitted only after both locks are released.

The no-seq-0 decision is also reflected in boot recovery. A `version_seq === 1` card accepts absent or empty history only; any row for that card, any `version_seq < 1`, gaps, or orphan tails are fatal `CardStoreInvariantError`s. The `create` marker remains useful for crash-safe by-id rename recovery while `marker.history === null` prevents accidental public history rows.

## Plan

No blocking issues.

The schema plan fixes the Zod `.omit()` problem by introducing `cardHistoryEntryBaseSchema` as a concrete `ZodObject`, deriving `cardHistoryHeaderSchema` from it, and only then exporting `cardHistoryEntrySchema` as the generic `ZodType<CardHistoryEntry>`. The allowed `kind` enum excludes `create`, and `version_seq` remains `z.number().int().positive()`.

The slim-layout work is specified clearly. [03-plan-r5.md](03-plan-r5.md) removes `cards/views` from `SAIVAGE_DIRS` along with `cards/tree` and `cards/dependencies`, adds `cards/.commit`, updates `isNewSaivageState`, and adds negative checks for all legacy derived artifacts including `cards/views/`. The file-tree tests are explicitly updated to expect only `['by-id', 'history', '.commit']` under `.saivage/cards/`.

Validation uses package scripts for web execution. The plan adds `web:test:card-history-panel` and invokes web checks through `npm run ...`; the script body itself may `cd web`, but the validation instructions no longer ask operators to run raw `cd web && npx vitest ...` commands. The plan also keeps `async-mutex` and `ts-morph` out of the dependency set and does not ask for docstrings/comments in untouched code.

## Cross-check

The r4 blockers are addressed: no seq-0 create tombstone remains in the public contract, the lock pseudo-code uses `withLock`, release ordering is corrected, `.omit()` is applied to a concrete base schema, `cards/views` is removed as part of the slim layout, and web validation is script-driven.

Source spot-checks agree with the plan's assumptions: [src/persistence/project-lock.ts](../../../src/persistence/project-lock.ts) exposes `new ProjectLock(...)`, `withLockSync`, `withLock`, and `assertOwns`; [src/schemas/validators.ts](../../../src/schemas/validators.ts) currently exports history through a lazy generic `ZodType`, so the concrete-base rewrite is needed; [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts) currently creates `cards/views`, so the slim-layout deletion is a real required edit.

F12 r4 acceptance coverage is present. The eight original items from [../F12-card-history-empty/03-plan-r4.md](../F12-card-history-empty/03-plan-r4.md) are preserved and strengthened with F13-specific `entry_id`, `kind`, create-exception, and invariant assertions. This is not byte-identical text despite the "copied VERBATIM" label, but it does not weaken or omit any F12 r4 acceptance requirement, so I am not treating it as a substantive blocker under the requested approval bias.

VERDICT: APPROVED