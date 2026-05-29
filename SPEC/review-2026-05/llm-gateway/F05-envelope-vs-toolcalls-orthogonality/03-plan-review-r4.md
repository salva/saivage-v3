# F05 plan r4 review

## Blocking finding

1. The batch validation commands cannot execute as written because the root test runner is Jest, not Vitest. The plan repeatedly uses `npm test -- --run ...` for baseline and batch gates ([03-plan-r4.md](03-plan-r4.md#L26), [03-plan-r4.md](03-plan-r4.md#L110-L112), [03-plan-r4.md](03-plan-r4.md#L323), [03-plan-r4.md](03-plan-r4.md#L351-L352), [03-plan-r4.md](03-plan-r4.md#L379-L380), [03-plan-r4.md](03-plan-r4.md#L413-L414), [03-plan-r4.md](03-plan-r4.md#L479)), but [package.json](../../../../package.json#L15) defines `npm test` as `jest`. I verified `npx jest --run --listTests tests/agents/session-persistence.test.ts` fails with `Unrecognized option "run"`. This breaks the green-checkpoint requirement for every batch that cites that command. Replace root targeted runs with Jest-compatible forms such as `npm test -- --runTestsByPath <tests...>` or `npm test -- <path-patterns>`, and use the web runner for web tests (`cd web && npx vitest run ...`, matching [web/package.json](../../../../web/package.json#L15)).

## Coverage notes

No other blocker found. The plan otherwise covers the approved design §9 implementation order, preserves the zero-backward-compatibility posture, deletes the dead result-parser / wrapper surfaces, assigns named tests to every approved analysis invariant, includes the terminal-tool observability plumbing, and has an explicit per-batch rollback plan.

VERDICT: CHANGES_REQUESTED