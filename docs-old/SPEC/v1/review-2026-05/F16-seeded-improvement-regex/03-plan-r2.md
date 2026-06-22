# F16 — Implementation plan (round 2)

Supersedes [03-plan-r1.md](./03-plan-r1.md). Implements [02-design-r2.md](./02-design-r2.md);
addresses [01-analysis-review-r1.md](./01-analysis-review-r1.md) objections.

Branch: `stage-44-permissions-by-state-matrix` (current). **No deployment** — F16
touches only Phase-2 audit tooling under `tmp/` and the matrix-authoring prompt; no
Saivage runtime artefact changes, so the production target
`saivage-v3-getrich.service` on 10.0.3.170 is unaffected.

## File-level changes

### 1. T35 — replace literal regex with structural linkage

- File: [tmp/.../test-matrix.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json)
  (workspace tmp/, not under saivage-v3 git).
- At T35 plan step (current line 941, text
  `"Locate a child card whose title or description matches /capture|announce/i"`),
  replace with:

  ```
  Locate a child card C of the seeded project root such that:
    - C.parent === "project" OR ancestor chain via parent reaches "project"
    - C.type ∈ {code, test, doc, research, ops}
    - C.status ∉ {backlog, drafting}
    - C.created_by === "planner"
    - C.description is non-empty OR C.acceptance is non-empty
  Record C.id (used as a matrix variable by T38, T39, T42).
  ```

- At T35 pass criterion (current line 953,
  `"at least one child mentions capture/announce"`), replace with:

  ```
  At least one new child card under the project root satisfies the structural check
  above (parent under project root; type in {code,test,doc,research,ops};
  status not in {backlog,drafting}; created_by=planner; description or acceptance
  non-empty). Card-store field names per src/schemas/validators.ts.
  ```

- At T35 purpose (current line 935), rephrase to:

  ```
  Planner creates ≥1 non-trivial child card pursuing a seeded improvement from
  docs/SPEC.md. Any valid improvement is acceptable — pass criterion is structural
  and does not literal-match planner-chosen tokens.
  ```

- `artifacts_to_capture` (lines 949–950) unchanged. `json:t35-cards.json` already
  carries C.id, C.title, C.description, C.acceptance — sufficient for the structural
  check and for the advisory recording for human review.

### 2. T38 — wait for the T35-selected card to reach terminal

- File: same `tmp/.../test-matrix.json`.
- At T38 title (current line 1032,
  `"Outcome: long-run — wait for seeded improvement to complete"`), replace with:

  ```
  Outcome: long-run — wait for the planner-selected seeded improvement to reach a terminal status
  ```

- At T38 purpose (current line 1035), replace with:

  ```
  Allow Saivage up to 5 min after T35 to take the planner-selected seeded-improvement
  card C (id carried forward from t35-cards.json; whatever its title) to a terminal
  status (ideally 'done').
  ```

- At T38 first plan step (currently `"Identify capture-announcement child card id C"`),
  replace with:

  ```
  Identify child card id C produced by T35 (carried forward via t35-cards.json; C.id
  is the matrix variable used by all downstream T39+ steps).
  ```

- Update T38 pass criteria to use schema-literal status names:

  ```
  C.status ∈ {done, failed, blocked, cancelled} within 300 s
  if C.status === 'done', proceed to T39–T44; else mark outcome-validity failed and record cause
  ```

  (replaces the current free-text `"status reaches terminal within 300s"` with an
  explicit reference to the Zod-enum literal set.)

### 3. T39 — generalize the diff assertion

- File: same `tmp/.../test-matrix.json`.
- At T39 plan step 3 (currently
  `"grep ui.js for /capture available/i — must be present in the new content"`),
  replace with:

  ```
  Confirm the diff touches at least one source file consistent with C.type (e.g. for
  C.type='code', expect changes under src/). If C.description references specific file
  paths (substring match), assert at least one of them is in the changed-files list.
  Do NOT literal-match planner-chosen tokens against file contents.
  ```

- At T39 pass criterion currently
  `"capture-availability string present in renderStatus path"`, replace with:

  ```
  At least one changed file is plausibly the implementation of C (heuristic: changed
  file path appears as a substring of C.description, OR all changed files live under
  the project source roots).
  ```

- T39 pass criteria `"ui.js diff non-empty"` and `"engine.js exports unchanged"`:
  - Rename `"ui.js diff non-empty"` → `"src/ diff non-empty"` (drops the capture-implied
    file pin to ui.js; the diff-non-empty invariant survives as a structural check on
    the project's source tree).
  - Keep `"engine.js exports unchanged"` as-is. This is a *no-regression of the seed
    project's pre-existing public API*; it is a property of the seed project, not of
    planner output, and holds regardless of which improvement was chosen.

### 4. T42 — two-tier scoping (Tier A always, Tier B conditional)

- File: same `tmp/.../test-matrix.json`.
- At T42 title (currently
  `"Outcome: playable game — capture announcement appears in UI"`), replace with:

  ```
  Outcome: playable game — built app serves and (if planner chose capture announcement) UI announces captures
  ```

- At T42 purpose, replace with:

  ```
  Serve the built checkers app and verify it still renders; additionally, if the
  planner-selected improvement C targets capture announcement, assert the announcement
  string appears in the status region.
  ```

- Replace T42 plan steps with Tier A + Tier B:

  ```
  Tier A (always):
    1. ssh root@10.0.3.180 'cd /work/saivage-e2e-checkers && (npx vite preview --host 0.0.0.0 --port 4173 &) ; sleep 3'
    2. playwright.navigate(http://10.0.3.180:4173)
    3. Snapshot initial board; assert board DOM and status region are present
    4. ssh kill the preview server

  Tier B (only if planner-selected C is the capture-announcement improvement, detected by
    C.id === "announce-required-captures" OR (C.description contains both "capture" and
    one of {"announce","status"} as case-insensitive substrings)):
    5. Drive moves via evaluate (call game.applyMove or click squares) to reach a state
       where captureAvailable returns true
    6. Assert status text contains /capture available/i AND dataset.captureAvailable === 'true'

  If Tier B is skipped because C is a different valid improvement, write
  t42-tierB-skip-reason.txt with C.id, C.title, and the substring-match outcome, and
  record Tier B as "not-applicable" in the matrix run record.
  ```

- Replace T42 pass criteria with:

  ```
  Tier A: page reachable; board DOM present; status region present
  Tier B (if applicable): status text mentions capture; dataset.captureAvailable correct
  Tier B (if not applicable): t42-tierB-skip-reason.txt written and Tier B recorded as 'not-applicable' (does NOT fail T42)
  ```

- Add `txt:t42-tierB-skip-reason.txt` to T42 `artifacts_to_capture` (currently
  `screenshot:t42-initial.png`, `screenshot:t42-capture-state.png`,
  `json:t42-status-text.json`).

### 5. Add a matrix-authoring rule to the audit prompt

- File: [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md).
- Append (or insert into an existing "Matrix authoring rules" section if one exists)
  the rule from Design r2:

  > Pass criteria for LLM-output dimensions (planner / executor / reviewer / analyst)
  > MUST measure structural properties (`parent`, `type`, `status`, `acceptance`,
  > `description` non-emptiness, `version_seq`, transition legality, child-count
  > growth) and MUST NOT literal-match planner-chosen tokens (titles, descriptions,
  > acceptance text). Downstream tests that depend on the planner-selected card MUST
  > refer to it by id (carried forward as a matrix variable from the upstream step)
  > and MUST either apply only structural checks, or be conditionalized on the
  > specific improvement chosen with a documented skip-reason for other valid
  > improvements. See `SPEC/v1/review-2026-05/F16-seeded-improvement-regex/`.

- Locate insertion point with
  `grep -n "Matrix authoring\|matrix authoring\|pass_criteria\|pass criteria" prompts/saivage-v3-checkers-e2e-testing-instance.md`;
  if no section exists, add a new heading near the existing test-matrix references and
  place the rule under it.

### 6. (No change) Do not touch

- `saivage-v3/src/**`, `saivage-v3/web/**`, `saivage-v3/tests/**`,
  `saivage-v3/docs/**`, `saivage-v3/SPEC/**` (other than this F16 directory).
- `tmp/.../G4-report.md` and `tmp/.../G5-report.md` — historical audit artefacts;
  leave the §T35 caveat narrative intact as audit trail.
- T35/T38/T39/T42 dependencies arrays, severity, dimension fields, depends_on chains —
  all unchanged.
- T40 (vitest), T41 (build), T43 (engine headless eval), T44 — already
  planner-output-invariant; no edits.
- `.saivage/**`, deployment configs, systemd units — untouched.

## Validation commands

Run from `/home/salva/g/ml` unless noted. F16 has **no Saivage build, no SSH restart,
no `/health` probe** because no runtime / web artefact changes. The validation surface
is the test-matrix edit itself plus a static sanity check.

1. JSON validity of the edited matrix:

   ```bash
   python3 -c "import json,sys; json.load(open('tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json'))" && echo OK
   ```

2. Confirm the literal regex no longer pin-points planner output at T35 / T38 / T39 /
   T42 pass-criteria or plan-step fields:

   ```bash
   python3 -c "
   import json
   m = json.load(open('tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json'))
   targets = {'T35','T38','T39','T42'}
   for t in m.get('tests', m if isinstance(m, list) else []):
       if t.get('id') in targets:
           blob = json.dumps([t.get('purpose'), t.get('plan'), t.get('pass_criteria'), t.get('title')])
           assert 'capture|announce' not in blob, t['id']
   print('OK')
   "
   ```

   (Note: the historical `/capture available/i` substring inside Tier B's plan step is
   intentional and acceptable — it is only evaluated when the planner chose the
   capture improvement; the check above scans for the bare `capture|announce` *regex
   token surface*, which is the literal-regex form r1 was using.)

3. Confirm the structural criterion landed at T35:

   ```bash
   grep -n 'C.parent\|C.type\|C.status\|created_by\|description is non-empty\|acceptance is non-empty' tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json
   # expected: multiple hits across T35 plan + pass_criteria.
   ```

4. Confirm the id-based hand-off landed at T38 / T39 / T42:

   ```bash
   grep -n 'C.id\|carried forward from t35-cards.json\|planner-selected card' tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json
   # expected: hits across T38 plan + T39 plan + T42 plan.
   ```

5. Confirm T42 Tier-B conditionalization:

   ```bash
   grep -n 'Tier A\|Tier B\|tierB-skip-reason\|not-applicable' tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json
   # expected: ≥3 hits inside the T42 block.
   ```

6. Confirm the authoring rule landed in the prompt:

   ```bash
   grep -n 'literal-match planner\|structural properties\|F16-seeded-improvement-regex' prompts/saivage-v3-checkers-e2e-testing-instance.md
   # expected: at least one hit referencing F16 / the new rule.
   ```

7. Saivage workspace regression sweep (sanity — should be **no-op** since no Saivage
   code changed):

   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx tsc -p tsconfig.json
   ```

   Reference:
   [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md).
   Skip server / web vitest sweeps — they are not in the change surface, so per
   skill guidance they are not required for this finding.

## Deployment

**Not applicable.** F16 changes no file shipped in `dist/` or `web/dist/`. The
Phase-2 test-matrix and the audit-prompt live in the workspace (not in the container
bind mount of `saivage-v3-getrich.service`). No SSH, no `systemctl restart`, no
`/health` probe.

## Backout

Single `git checkout` of the edited files restores prior behaviour. The test-matrix
file is under `tmp/` (workspace tmp/, not git-tracked under saivage-v3); if not
version-controlled in any sibling git tree, keep a one-off backup
`tmp/.../test-matrix.json.bak` before the edit and restore from it on backout.

## Acceptance

- All seven validation commands above return their expected results.
- A dry-read of T35 / T38 / T39 / T42 by a new subagent finds:
  - No literal-token assertion against planner output at T35 / T38 (objections #1, #2
    addressed at the matrix level).
  - All card-field references use `parent` (not `parent_id`); all card-type literals
    are from the Zod enum `{project, goal, architecture, code, test, doc, data,
    research, ops}` (no `analysis`); all status literals from the Zod enum (objection
    #2 addressed at the wording level).
  - T39 diff assertion is planner-output-invariant; T42 has Tier A unconditional and
    Tier B conditional on the planner-selected improvement with a documented
    skip-reason path (objection #3 addressed).
- The matrix-authoring prompt carries the new rule so the regression cannot re-enter
  on the next Phase-N authoring round.
- Future Phase-N re-runs of T35 / T38 PASS regardless of which valid improvement the
  planner picks (provided the new card is structurally non-trivial and parented under
  the project root and the planner advances it to a terminal status); T39 / T42 PASS
  (with Tier B marked not-applicable on non-capture improvements).
