# Batch B Plan Review R2

## Verdict

Approved. R2 substantively resolves the five R1 findings.

## R1 Resolution Check

1. **Cross-batch contract ownership and failure boundaries are resolved.** R2 names Batch B as the sole owner of `Contract<Envelope, TypedResult>`, splits the landing into a skeleton phase consumed by the verifier batch and a continuation phase after it, and changes skeleton verification failures to a local `ContractViolation` shape rather than `LlmRequestError`. The continuation step then routes `contract.verify(call)` through Batch A's `ContractVerifier`, which lifts contract failures into `ObligationReport` repair flow without reintroducing `contract_mismatch` as a transport failure.

2. **Compile-green ordering is now credible.** The skeleton phase adds contract files and tests without deletions, moves envelope schemas behind a temporary re-export so existing callers keep compiling, and copies projection helpers until the adapter is rewritten. The continuation phase groups dependent adapter, parser, prompt, recorder, policy, and deletion work into atomic steps instead of claiming isolated deletions can compile by themselves.

3. **Validation targets the correct runner and path.** The validation block now uses `npm test -- --runInBand` for root Jest tests, keeps `npm run typecheck` and `npm run build`, and links the workspace validation skill through the workspace-root `.github` path rather than a target-project-local path.

4. **Prompt constraint preservation is explicit.** The prompt rewrite step now requires diffing each hand-written JSON example before deletion, moving non-schema behavioural constraints into role-specific prose, and adding `system-prompt.preserved-constraints.test.ts` to assert both contract rendering and preserved constraint strings.

5. **The new authorization surface has direct tests.** R2 adds a focused `role-tool-policy.contract-terminal.test.ts` covering contract-terminal allow/deny cases, missing or empty terminal lists, rejection of terminal names on other surfaces, and unchanged decisions for existing non-terminal surfaces.

## Notes

No remaining R1 blocker is open. The plan remains aligned with the approved design and the coordination document's substantive ownership model: Batch B owns the canonical contract value and factories, while Batch A consumes the contract through the verifier and repair loop.

VERDICT: APPROVED