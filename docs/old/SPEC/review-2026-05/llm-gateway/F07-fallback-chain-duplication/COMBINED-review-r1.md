# F07 — Combined r1 Review

## Findings

1. **Blocker — top-level failover removal is incomplete and would create silently ignored configuration.** [COMBINED-r1.md](COMBINED-r1.md#L64) says top-level `failover` is removed and `models.failover` becomes the only accepted form, but Batch B1 only removes the router fallback and adjusts one router test ([COMBINED-r1.md](COMBINED-r1.md#L124), [COMBINED-r1.md](COMBINED-r1.md#L135)). Today the root schema still accepts `failover` ([src/agents/config-schema.ts](../../../../src/agents/config-schema.ts#L238)), a schema test asserts that top-level form loads ([tests/agents/config-schema.test.ts](../../../../tests/agents/config-schema.test.ts#L252)), and `setFailoverOrder` writes `raw.failover` at the root ([src/agents/analyst-config-writer.ts](../../../../src/agents/analyst-config-writer.ts#L60-L62)). Implemented as written, the analyst reconfigure tool can validate and persist a top-level failover chain that the router ignores after `topFailover` is deleted. Required fix: make Batch B1 remove root `failover` from `saivageConfigSchema`, replace the top-level schema test with rejection coverage, update `setFailoverOrder` to write `models.failover` or remove that tool path, and add coverage proving the analyst writer emits only the accepted shape.

## Advisory

- While adding the `models.default` duplication invariant, consider also rejecting empty per-role model arrays so an override cannot silently suppress the default. This is adjacent hygiene, not required for F07 approval once the failover source-of-truth gap is fixed.

VERDICT: CHANGES_REQUESTED