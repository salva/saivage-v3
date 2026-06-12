# Research notes — Wave 001 scope and proposals

Date: 2026-05-26  
Task: `t1-scope-and-proposals`

## Executive summary

The Wave 001 premise remains valid against current code: `Runtime` is still the central coordinator, and `RuntimeStateMachine` exists but depends on concrete card/runtime/error infrastructure instead of explicit ports and pure transition contracts.

Artifacts written for the cycle:

- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/scope-check.md`
- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-direct.md`
- `architecture-audit/cycle-001-runtime-core-ports-and-state-machine-extraction/proposals/proposal-restructure.md`

Recommended reviewer focus: prefer `proposal-direct.md` unless review believes command-ledger/state orchestration must move into a new engine in this first wave. The direct proposal is smaller, preserves current behavior, and still extracts the most valuable pure transition decision logic and explicit ports.

## Key evidence from current source

- `Runtime` still owns broad command, dispatch, state, event, planner/executor/reviewer, cleanup, and transition coordination (`src/runtime/runtime.ts:102`, `src/runtime/runtime.ts:119`, `src/runtime/runtime.ts:481-553`, `src/runtime/runtime.ts:607-818`).
- The old `RuntimeStateMachine` implementation has since been removed; card transition decisions now live in the pure `transition-policy.ts` module.
- State-machine tests use real `CardStore`, runtime state files, and `ErrorLogger`, which verifies behavior but keeps tests coupled to concrete infrastructure (`tests/runtime/state-machine.test.ts:34-48`, `tests/runtime/state-machine.test.ts:177-196`).
- `tests/runtime/state-machine-wired.test.ts` asserts `Runtime` exposes `runtime.stateMachine`, which may be an implementation-private surface to delete or replace if the implementation narrows the API (`tests/runtime/state-machine-wired.test.ts:10-24`).

## Current diff caveat

The working tree contains unrelated existing changes. Relevant scoped current diff already introduces `PROJECT_CARD_ID` into `src/runtime/runtime.ts` and `src/runtime/state-machine.ts` and adds canonical project-card tests. Wave 001 should preserve this current behavior and avoid reverting it.

## Source citations

All citations are project-local `path:line` evidence gathered from the current working tree on 2026-05-26. No external web sources were needed for this source-code research task.
