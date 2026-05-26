# Stage 010c inventory and feasibility audit

Access date: 2026-05-26.

## Executive summary

Stage 010c is **not ready to proceed with real S1-S68 authoring on the current fixture as-is** because the analyst Playwright fixture still inherits ambient checker `.saivage` configuration and auth files. That violates the retry objective's deterministic non-secret boundary unless the next coding task first replaces it with either:

1. a deterministic recorded-conversation/playback configuration, or
2. an explicitly bounded non-secret analyst provider configuration that is safe to generate in the temp project.

Other readiness signals are good: `/work/saivage-e2e-checkers` is now a clean independent git repo at `260fe981c66c67aa9b76d7b17cba8df6f756344c`; the previous placeholder S9-S68 suite remains quarantined and executable `scenarios.spec.js` is only a guard; the cumulative ledger currently has zero open H3 entries; v3 has the prior forbidden-token repair commit `f85cf1c`; strict forbidden-token grep over the charter trees currently has zero hits.

## Sources consulted

Local immutable/project sources:

- `SPEC/analyst-as-control-surface/SPEC-r7.md`
- `SPEC/analyst-as-control-surface/PLAN/00-MASTER-PLAN-r7.md`
- `SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/design.md`
- `SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/plan.md`
- `.saivage/stages/010-test-suite-and-ledger-reconciliation/summary.json`
- `.saivage/stages/010b-version-e2e-checker-infrastructure/summary.json`
- `/work/saivage-e2e-checkers/e2e/analyst/scenarios.spec.js`
- `/work/saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js`
- `/work/saivage-e2e-checkers/e2e/analyst/findings/findings.md`
- `/work/saivage-e2e-checkers/e2e/analyst/README.md`

Research command evidence was captured under `.saivage/tmp/t1-*.out` and `.saivage/tmp/t1-*.err`.

## Current repository state

### v3 repository

`git_status` reported no tracked modified/added/deleted files before this research write. It did show pre-existing untracked SPEC/research artifacts unrelated to this task.

Recent v3 history includes the important Stage 010 repair commit:

```text
f85cf1c [tsk-t3-phases-d-e-unit-vitest-forbidden-tokens] reconcile unit vitest forbidden tokens
```

`git show --stat f85cf1ce` confirmed it touched only the expected forbidden-token repair tests:

- `tests/agents/agent-adapter-force-final-answer.test.ts`
- `tests/agents/agent-adapter-non-planner-tools.test.ts`
- `tests/agents/analyst-tool-surface.test.ts`
- `tests/integration/runtime-redesign-golden.test.ts`
- `tests/server/operator-api-contracts.test.ts`

### checker repository

The sibling checker is commit-capable and currently clean:

```text
HEAD 260fe981c66c67aa9b76d7b17cba8df6f756344c
260fe98 [t1-checker-versioning-and-cleanup] ignore local checker saivage config
a6182db [t1-checker-versioning-and-cleanup] initialize checker baseline after placeholder quarantine
```

This satisfies the infrastructure prerequisite from Stage 010b: subsequent checker changes can be committed in `/work/saivage-e2e-checkers` and the resulting checker SHA can be reported.

## Analyst fixture feasibility

### Current fixture behavior

`e2e/analyst/fixtures/saivage-server.js` still copies local checker credentials/config into each temp project:

```js
const checkersAuth = join(CHECKERS_DIR, '.saivage/auth-profiles.json');
const checkersSaivage = join(CHECKERS_DIR, '.saivage/saivage.json');
if (existsSync(checkersAuth)) {
  copyFileSync(checkersAuth, join(projectRoot, '.saivage/auth-profiles.json'));
}
if (existsSync(checkersSaivage)) {
  copyFileSync(checkersSaivage, join(projectRoot, '.saivage/saivage.json'));
}
```

I did **not** read either secret/config file. The fixture source and comments are sufficient to establish the behavior.

The fixture comments state the reason:

```text
Inherit LLM credentials + provider config from the checkers project so the analyst has real LLM access.
```

### Playback/deterministic support search

A search for `recordedConversation`, `playback`, `deterministic`, `mock`, and `stub` under the checker `e2e`/`src` trees found no usable deterministic recorded-conversation playback implementation. The only relevant hit was the checker analyst README's stale/diagnostic note about a prior hardcoded LLM stub.

The current v3 `src/agents/analyst-llm-resolver.ts` is not a hardcoded unavailable stub: `isAvailable()` resolves the analyst model chain, and `chat()` uses `LlmClient.complete(...)` with the analyst tool definitions. Therefore real provider-backed Analyst execution is implemented, but the checker fixture currently relies on ambient local auth/config to reach it.

### Feasibility conclusion

Under the published Stage 010 Phase A.1 requirement, the current fixture does **not** meet either allowed shape:

- It does not pin and write a documented non-secret analyst-capable provider/model config in the temp project.
- It does not reference a recorded-conversation playback run.

Therefore the retry should not author S1-S68 on top of the fixture unchanged. The first coding step should replace this behavior with a deterministic non-secret provider/playback strategy; if that cannot be completed, Stage 010c must escalate before presenting S1-S68 PASS evidence.

## Executable analyst e2e state

The current executable `e2e/analyst/scenarios.spec.js` is only a quarantine guard. It explicitly says it is **not Stage 010 functional coverage** and asserts the old placeholder suite remains outside the executable suite.

Current findings file likewise states it is not completion evidence:

```text
Stage 010b infrastructure cleanup intentionally invalidated the generated Stage 010 findings.
...
This file is not Stage 010 completion evidence.
```

Quarantine files exist under:

```text
e2e/analyst/quarantine/2026-05-26-stage010-placeholder-quarantine/
```

Coder guidance:

- Replace the guard with real scenarios; do not delete the quarantine evidence unless the stage plan explicitly allows it.
- Regenerate `findings/findings.md` only from a real S1-S68 run.
- Do not count the current one-test guard as analyst-e2e completion coverage.

## Tool registry and absence checks

`src/agents/analyst-tool-schemas.ts` exposes the expected Analyst tool surface, including:

- card mutation/read tools: `create_card`, `edit_card`, `move_card`, `delete_card`, `list_cards`, `get_card`, `get_tree`, history/diff tools
- runtime tools: `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `restart_goal`, `terminate_process`
- notification queueing: `queue_notification`
- reorder/navigation/config/read tools: `reorder_child`, `navigate_workspace`, `navigate_back`, `show_config`, `reconfigure`, file/runtime/process/session/audit read tools

The specific forbidden notification management/read tools were absent from the registry search:

- `list_notifications`
- `get_notification`
- `acknowledge_notification`
- `_ack`/`acknowledge`-named analyst tools

One important implementation detail for the coder: the registry uses `reorder_child`, not `reorder_children`, and `delete_card` takes `ids: string[]`, not the Stage 010 plan's older `target_id` wording.

## Ledger, baseline, forbidden-token, and candidate deletion inventory

### Ledger and baseline

Current ledger open-entry count:

```text
0
```

Current `baseline-gates.json` summary:

```text
tsc-build: 0 failing_ids, observed_exit_code=0
web-vite-build: 0 failing_ids, observed_exit_code=0
web-vitest: 8 failing_ids, observed_exit_code=1
analyst-e2e: 0 failing_ids, observed_exit_code=0
```

This matches the Stage 010 summary: the baseline was restored after escalation and must not be refreshed until real S1-S68 coverage and all final gates pass.

### Strict forbidden-token grep

A grep over the charter trees for `mark_note_handled|list_notes|preview_hash` returned zero hits at audit time.

### Candidate deletion files

Candidate legacy test files are already absent:

```text
ls: cannot access 'tests/utils/runtime-queue-notification.test.ts': No such file or directory
ls: cannot access 'tests/utils/operator-chat-control.test.ts': No such file or directory
```

Current component test inventory is minimal:

```text
web/src/__tests__/components/AnalystChatPanel.children.test.ts
```

## Scenario authoring risk notes for t2

1. **Fixture first.** Replace the ambient `.saivage` copy behavior before writing PASS-generating scenarios. Otherwise the tests remain non-reproducible and may leak dependence on local secrets.
2. **Prompt preservation.** Recover S1-S8 wording/turn structure from the checker baseline/quarantine as needed; Phase B requires fixture/assertion repair rather than prompt rewriting.
3. **No placeholder completion.** S9-S68 must send natural-language prompts through `/api/chats/<sessionId>` or equivalent UI-backed Analyst path and assert tool calls, tool results, REST-visible side effects, and DOM effects where required.
4. **Respect current tool names/shapes.** Use `delete_card({ ids: [...] })` and `reorder_child({ parentId, orderedChildIds })`; do not write tests against nonexistent plan-era names.
5. **Baseline refresh last.** Leave `baseline-gates.json` untouched until real e2e and all v3 gates pass.

## Verdict

Audit completed. Stage 010c remains feasible only if t2 first implements a deterministic non-secret Analyst execution fixture or a recorded playback path. The checker repository can now receive a real commit, and v3 appears clean enough to preserve prior legitimate Stage 010 repairs while the checker e2e work is redone.
