# F22 — Planner role has no default model list at boot

## Summary

With all 15 roles explicitly populated in `.saivage/saivage.json` (`models.planner = ["gpt-5.5"]`), the first planner cycle on a cold boot still emitted `No model list configured for role 'planner' and no default.` (`errors.jsonl` line 1, 2026-05-23 13:31:29). Subsequent planner cycles succeeded. Either there is an ordering bug (the role-routing table is consulted before the config loader finishes), or the default-fallback chain assumes a sibling role can stand in but no such fallback is registered. Each cold boot consumes one wasted planner attempt and surfaces an alarming "no model" error in the operator's errors view.

## Evidence

- Phase-2 G5/T45: [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/G5-report.md) §T45; raw `errors.jsonl` excerpt at line 1.
- Owner code: [src/config/](../../../src/config/) (loader), [src/agents/](../../../src/agents/) (role → model resolution), [src/boot/](../../../src/boot/) (startup ordering).

## Category

bad design (boot-order race) / inconsistency (config says yes, resolver says no)

## Severity

P1 — every cold boot fails the first planner cycle; on operator restart this is the first visible runtime error.

## Transversality

Cross-cutting: config loader, boot sequencer, agent role registry. Resolution likely requires either a fail-fast validation (refuse to start with missing roles) or a deterministic ordering (block planner dispatch until config is fully loaded).
