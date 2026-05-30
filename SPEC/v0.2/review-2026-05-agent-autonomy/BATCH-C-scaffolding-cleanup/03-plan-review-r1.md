# Batch C Plan Review R1

## Verdict

Changes requested. The plan is aligned with the approved P-C1 target shape, but it has substantive execution holes that should be corrected before implementation starts.

## Findings

1. **The step ordering does not keep the tree compile-green after each step.** Section 3 says the steps are ordered so `npm run build` is green after each step, but step 1 deletes and renames the `LlmCompleteOptions` / `buildLlmOptions` surface while explicitly leaving call-site breakage for steps 2-4. Step 2 likewise verifies recorder and gateway tests only "after rewriting those test bodies per step 14," so it is not a self-contained green slice. Batch C should either widen those early steps to update every production and test caller in the same step, or remove the per-step green guarantee and treat the F01 option-shape rewrite as one atomic implementation slice.

2. **Validation uses the wrong root test runner for `saivage-v3`.** The plan repeatedly uses `npx vitest run tests/agents/...`, `npx vitest run tests/contracts/...`, and a full `npx vitest run` for root tests. `saivage-v3/package.json` runs root `tests/` with Jest (`npm test` / `npm run test:direct`); Vitest is only wired for the web workspace. The focused and final validation commands need to be rewritten to use `npm test -- --runInBand ...` or the local Jest equivalent for root suites, keeping Vitest only through `web:` scripts. Otherwise the plan can pass while not exercising the intended agent/contracts tests.

3. **The live smoke target points at the wrong Saivage service.** Section 7 says to deploy Saivage v3 build artifacts and check `http://10.0.3.112:8080/health`, but the workspace map identifies `10.0.3.112` as the v2 harness working on the `saivage-v3` target project, while the Saivage v3 deployment is `saivage-v3-getrich-v2` at `10.0.3.170:8080`. The validation section should either explicitly say it is smoke-testing the v2-on-v3 harness, or change the deployment/health check to the actual Saivage v3 service.

## Non-Blocking Notes

- The no-backward-compatibility requirement is respected: the plan deletes legacy option phases, runtime-config migration arms, recovery wrappers, and old recorder fields rather than preserving aliases.
- The collaborator inventory matches the approved design: `CandidateResolver`, `AgentSessionLifecycle`, `ConversationRunner`, `InvocationAttemptRecorder`, `OuterAttemptLoop`, and `InvocationOutcomeProjector` map cleanly to the P-C1 responsibilities.
- The acceptance-grep list is strong once the validation runner and slicing issues are fixed.

VERDICT: CHANGES_REQUESTED