# Saivage v3 — Release Checklist

Use this checklist to verify a release candidate against the current repaired system rather than against historical plans.

## Documentation gates

- [ ] Active docs reflect current source and tests.
- [ ] No active doc presents historical generated plans or remediation notes as current authority.
- [ ] `docs/documentation-inventory.md` is updated when doc scope changes.
- [ ] Historical material is either excluded from active guidance or clearly labeled via [Historical Artifacts](/historical-artifacts).
- [ ] `README.md` links to current docs, not obsolete design-era references.

## Documentation build and verification

- [ ] Run docs verification:
  ```bash
  npm run docs:verify
  ```
- [ ] If needed, run the raw VitePress build separately:
  ```bash
  npm run docs:build
  ```
- [ ] Confirm `/docs/` serves built docs in a running server build.

## Core checks

- [ ] TypeScript typecheck passes:
  ```bash
  npm run typecheck
  ```
- [ ] Web typecheck passes:
  ```bash
  npm run web:typecheck
  ```
- [ ] Web sweep passes:
  ```bash
  npm run web:test:sweep
  ```
- [ ] Test suite passes at the chosen release scope:
  ```bash
  npm test
  ```

## Security and containment checks

- [ ] `/health` is public and reports runtime from the configured project root.
- [ ] `/api/*` is token-protected when `SAIVAGE_API_TOKEN` is configured.
- [ ] `/ws` rejects unauthorized connections when auth is enabled.
- [ ] `.saivage/auth-profiles.json` is blocked from file preview.
- [ ] `.saivage/saivage.json` is redacted rather than exposing literal secrets.
- [ ] path traversal attempts are rejected by file APIs.
- [ ] process views expose safe redacted metadata rather than raw registry internals.

## Operator workflow checks

- [ ] Dashboard shows meaningful unauthorized, reconnecting, stale, and degraded states.
- [ ] Cards detail exposes generated-file evidence and verification-command inspection.
- [ ] Agents view supports conversation inspection and linked-entity navigation.
- [ ] Files view surfaces blocked, missing, redacted, and unauthorized states intentionally.
- [ ] Debug exposes state, events, errors, supervision, MCP, and process diagnostics.
- [ ] Docs nav is visible from the control room and does not require API auth.

## Runtime control checks

- [ ] Pause and resume behave as documented.
- [ ] Freeze records a freeze state and reason.
- [ ] `resume-from-freeze` restores from a valid manifest.
- [ ] Operators are not forced to infer completion from empty queues alone.

## Build and serving

- [ ] Root build succeeds:
  ```bash
  npm run build
  ```
- [ ] SPA serves from `/`.
- [ ] Docs serve from `/docs/`.
- [ ] Built artifacts are not committed unintentionally.

## Final sign-off

- [ ] Versioning/release notes are updated as needed.
- [ ] Known follow-ups are documented explicitly.
- [ ] No release decision relies on stale design-era or generated-plan assumptions.
