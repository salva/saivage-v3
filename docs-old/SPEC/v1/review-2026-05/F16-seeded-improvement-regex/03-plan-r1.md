# F16 — Implementation plan (round 1)

Branch: `stage-44-permissions-by-state-matrix` (current). **No deployment** — F16 touches only Phase-2 audit tooling under `tmp/` and the matrix-authoring prompt; no Saivage runtime artefact changes, so the production target `saivage-v3-getrich.service` on 10.0.3.170 is unaffected.

## File-level changes

### 1. Relax T35 plan step and pass criteria

- File: [tmp/.../test-matrix.json](../../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json) (workspace tmp/, not under saivage-v3 git).
- Edit at line 941: replace `"Locate a child card whose title or description matches /capture|announce/i"` with `"Locate a child card whose parent_id (or hierarchical ancestor) is the seeded project root, type ∈ {code, analysis}, with non-empty acceptance, and status ∉ {backlog}"`.
- Edit at line 953: replace `"at least one child mentions capture/announce"` with `"at least one new child card is structurally non-trivial (parented under the project root, type ∈ {code, analysis}, non-empty acceptance, status ∉ {backlog})"`.
- Keep `purpose` field (line 935) free-text but rephrase to `"Planner creates ≥1 non-trivial child card pursuing a seeded improvement from docs/SPEC.md (any valid improvement; do not literal-match planner-chosen tokens)."`.
- Leave `artifacts_to_capture` (lines 949-950) unchanged — same JSON + screenshot inputs satisfy the new criterion.

### 2. Realign T38 wording with the new criterion

- File: same `tmp/.../test-matrix.json`.
- Edit at line 1032: replace title `"Outcome: long-run — wait for seeded improvement to complete"` with `"Outcome: long-run — wait for the planner-selected seeded improvement to reach a terminal status"`.
- Edit at line 1035: replace `"Allow Saivage up to 5 min after T35 to take the capture-announcement card to status 'done'."` with `"Allow Saivage up to 5 min after T35 to take the planner-selected seeded-improvement card (whatever its title) to a terminal status (ideally 'done')."`
- Edit the first plan step (around line ~1043, currently `"Identify capture-announcement child card id C"`) to `"Identify the child card id C produced by T35 (carried forward via the t35-cards.json artefact)"`.
- Leave `pass_criteria` (terminal status within 300s; ideally `done`) unchanged.

### 3. Add a matrix-authoring rule to the audit prompt

- File: [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md).
- Append (or insert into the existing "Matrix authoring rules" section if one exists) a single rule: *"Pass criteria for LLM-output dimensions (planner / executor / reviewer / analyst) MUST measure structural properties (parent_id, type, status, acceptance, version_seq, transition legality) and MUST NOT literal-match planner-chosen tokens (titles, descriptions, acceptance text). Rationale: the planner runs at non-zero temperature and is allowed to pick any valid improvement from docs/SPEC.md; literal matches produce non-deterministic false negatives. See SPEC/v1/review-2026-05/F16-seeded-improvement-regex/."*
- Locate insertion point with `grep -n "Matrix authoring\|matrix authoring\|pass_criteria\|pass criteria" prompts/saivage-v3-checkers-e2e-testing-instance.md`; if no section exists, add a new heading near the existing test-matrix references and place the rule under it.

### 4. (No change) Do not touch

- `saivage-v3/src/**`, `saivage-v3/web/**`, `saivage-v3/tests/**`, `saivage-v3/docs/**`, `saivage-v3/SPEC/**` (other than this F16 directory) — no Saivage product change.
- `tmp/.../G4-report.md` and `tmp/.../G5-report.md` — historical audit artefacts of the 2026-05-23 run. Leave the §T35 caveat narrative intact as the audit trail explaining why F16 was raised.
- `tmp/.../test-matrix.json` artifacts list, dependencies arrays, severity, dimension fields — all unchanged.
- `.saivage/**`, deployment configs, systemd units — untouched.

## Validation commands

Run from `/home/salva/g/ml` unless noted. F16 has **no Saivage build, no SSH restart, no `/health` probe** because no runtime / web artefact changes. The validation surface is the test-matrix edit itself plus a static sanity check.

1. JSON validity of the edited matrix:
   ```bash
   python3 -c "import json,sys; json.load(open('tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json'))" && echo OK
   ```
2. Confirm the literal regex no longer pin-points planner output:
   ```bash
   grep -n 'capture|announce' tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json
   # expected: no hits in pass-criteria or plan-step fields; only historical
   # mentions in surrounding narrative (which we do not edit) are acceptable.
   ```
3. Confirm the structural criterion is present:
   ```bash
   grep -n 'structurally non-trivial\|parent_id\|seeded project root' tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json
   # expected: ≥2 hits across T35 plan + pass_criteria.
   ```
4. Confirm the authoring rule landed in the prompt:
   ```bash
   grep -n 'literal-match planner\|structural properties\|F16-seeded-improvement-regex' prompts/saivage-v3-checkers-e2e-testing-instance.md
   # expected: at least one hit referencing F16 / the new rule.
   ```
5. Saivage workspace regression sweep (sanity — should be **no-op** since no Saivage code changed):
   ```bash
   cd /home/salva/g/ml/saivage-v3 && npx tsc -p tsconfig.json
   ```
   Reference: [.github/skills/saivage-development-validation/SKILL.md](../../../../.github/skills/saivage-development-validation/SKILL.md). Skip server / web vitest sweeps — they are not in the change surface, so per skill guidance they are not required for this finding.

## Deployment

**Not applicable.** F16 changes no file shipped in `dist/` or `web/dist/`. The Phase-2 test-matrix and the audit-prompt live in the workspace (not in the container bind mount of `saivage-v3-getrich.service`). No SSH, no `systemctl restart`, no `/health` probe.

## Backout

Single `git checkout` of the edited files restores prior behaviour. The test-matrix file is under `tmp/` (workspace tmp/, not git-tracked under saivage-v3); if not version-controlled in any sibling git tree, keep a one-off backup `tmp/.../test-matrix.json.bak` before the edit and restore from it on backout.

## Acceptance

- All five validation commands above return their expected results.
- A dry-read of T35 / T38 by a new subagent finds no literal-token assertion against planner output.
- Future Phase-N re-runs of T35 PASS regardless of which valid improvement the planner picks, provided the new card is structurally non-trivial and parented under the project root.
