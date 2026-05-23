# F21 — Implementation plan (r1)

Chosen design: **Proposal A** in [02-design-r1.md](./02-design-r1.md). Companion analysis:
[01-analysis-r1.md](./01-analysis-r1.md).

Validation surface lives in
[.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md).
Backend tests use Jest
(`NODE_OPTIONS=--experimental-vm-modules npx jest <focused> --runInBand --forceExit`). Web
tests, if touched, use Vitest. Deployment: host `npm run build`, then SSH restart of
`saivage-v3-getrich.service` on `10.0.3.170`, then `curl /health`. No rsync.

## Sequencing rationale

F21 is local to one schema and one handler. The plan is a single PR-sized change.
Independent of F12/F13: those rewrite the write path; this only touches the diff read
path. F21 can land before, alongside, or after F12/F13.

## Step 1 — Widen `CardDiffQuerySchema` and rewrite the `cards.diff` handler

**Files modified:**

- [src/contracts/operator-api.ts](../../../../src/contracts/operator-api.ts) — replace
  `CardDiffQuerySchema` at line 155 with the `diffPivotSchema` union described in
  [02-design-r1.md §Schema](./02-design-r1.md). Keep
  `CardDiffResponseSchema`
  ([:158](../../../../src/contracts/operator-api.ts#L158)) unchanged.
- [src/server/routes/operator-contracts.ts](../../../../src/server/routes/operator-contracts.ts)
  — rewrite the `'cards.diff'` handler at lines 135-146 per
  [02-design-r1.md §Handler](./02-design-r1.md). Delete the `Number.parseInt`-based 400
  branch (do not leave it commented; per project guideline, no dead code).

**Backend tests (Jest) — files modified/added:**

- [tests/api/cards-history.test.ts](../../../../tests/api/cards-history.test.ts) — keep
  the existing "diff with redacted values" case
  ([:93-99](../../../../tests/api/cards-history.test.ts#L93-L99)). Keep the
  `from=a&to=2 → 400` assertion at line 109; the new schema still rejects `a`. Add four
  new cases in the same `describe`:
  1. `GET /api/cards/code-1/diff?from=1&to=last` → 200, `to === current_version_seq`,
     diff non-empty for the seeded card.
  2. `GET /api/cards/code-1/diff?to=last` (no `from`) → 200, `from === max(1, to-1)`.
  3. `GET /api/cards/code-1/diff` (no params) → 200, defaults applied.
  4. `GET /api/cards/code-1/diff?from=last&to=1` → 400 (post-resolution `from > to`).
  5. `GET /api/cards/code-1/diff?from=1&to=current` → 200 (alias parity with `last`).
  6. `GET /api/cards/code-1/diff?from=0&to=last` → 400 (regex rejects `0`).
- No test deletions. The existing 400 case is still valid input under the new schema.

**Validation:**

- `npm run typecheck` from `saivage-v3/`.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/api/cards-history.test.ts --runInBand --forceExit`.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/server/operator-api-contracts.test.ts --runInBand --forceExit`
  (verifies `cards.diff` contract round-trips; the operation id is referenced at
  [tests/server/operator-api-contracts.test.ts#L116](../../../../tests/server/operator-api-contracts.test.ts#L116)).

**Rollback:** revert the two source files and the test additions. No on-disk state, no
schema migration.

**Transversality:** 2 source files + 1 test file. 0 web files. 0 schemas added or
deleted.

## Step 2 — Build and live-verify on the GetRich v2 harness

Per [validation skill](../../../../../.github/skills/saivage-development-validation/SKILL.md):

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

Then exercise the diff endpoint against a real card on the harness. Pick any card id
visible via `curl -fsS -H "Authorization: Bearer $TOKEN" http://10.0.3.170:8080/api/cards`
and run:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://10.0.3.170:8080/api/cards/<id>/diff?from=1&to=last" | jq '.from, .to, (.diff|length)'
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://10.0.3.170:8080/api/cards/<id>/diff" | jq '.from, .to'
curl -fsS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://10.0.3.170:8080/api/cards/<id>/diff?from=a&to=2"   # expect 400
curl -fsS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://10.0.3.170:8080/api/cards/<id>/diff?from=0&to=last" # expect 400
```

Do NOT print the token or pipe it into logs. Source it from the operator's local
environment per [WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md). No rsync;
the host code is bind-mounted into the LXC.

**Rollback:** `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'` after
`git revert` on the host. The service picks up the reverted build through the bind mount.

## Acceptance checklist

Each item must be green before requesting reviewer sign-off.

1. `npm run typecheck` passes.
2. Focused Jest runs in step 1 pass; full `npm test` (`NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit`) does not introduce new failures.
3. `npm run build` succeeds on the host.
4. `systemctl is-active saivage-v3-getrich.service` reports `active` post-restart.
5. `curl /health` on `10.0.3.170` returns 200.
6. The four live `curl` checks above match the expected status / body shape.
7. No Vue SFC build was triggered (this change does not touch `web/`); SFC duplicate-
   block precheck is not required.
8. No `comments` or `docstrings` were added to code outside the edited diff regions.
