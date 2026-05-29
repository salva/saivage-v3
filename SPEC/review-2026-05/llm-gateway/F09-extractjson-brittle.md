# F09 — `extractJson` brace-span fallback can extract wrong substring

## Summary

The third fallback in `extractJson` slices from the first `{` to the last `}` in the raw response and tries `JSON.parse` on the slice. For responses such as `"sure, here is the plan: {actions: [...]} and a note { not json }"` the slice spans both braces, yielding invalid JSON or — worse — valid-but-wrong JSON when the prose itself happens to bracket-balance.

## Evidence

- [src/agents/result-parser.ts#L257-L271](src/agents/result-parser.ts#L257) — see F02 for the snippet.
- No length cap, no validity check beyond the bare `JSON.parse`, no rescue with structured Zod parsing.
- Same extractor is used for planner, executor and reviewer envelopes; the only safety net is `buildExecutorFallbackResult` ([src/agents/result-parser.ts#L210-L256](src/agents/result-parser.ts#L210)), which is executor-only.

## Category

architectural / robustness

## Severity

medium — most failures today are dominated by F02's no-JSON-at-all case. Once F01/F02 are fixed, F09 becomes the next-most-likely failure mode for chat providers that prefix prose around a code block.

## Transversality

scoped to `result-parser.ts` and its tests.

## Recommended direction

- Anchor extraction on the canonical envelope key (e.g. `"thought"` for planner, `"actions"` for planner/executor) by walking balanced braces from that anchor outwards.
- After extraction, validate against the per-role Zod schema. On schema failure, throw `ResultParseError` carrying both the slice and the schema diff.
- Add fuzz tests that prepend / interleave prose around a real envelope and assert the extractor finds the right one.

## Cross-links

- F02 — same module, different failure mode.
- F05 — moving the envelope into a tool call removes this code path entirely.
