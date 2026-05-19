# Release

Use this checklist for a release candidate against the current repaired system.

## Documentation gates

- [ ] Active docs reflect current source and tests.
- [ ] No active doc presents historical plans or remediation notes as current authority.
- [ ] `docs/documentation-inventory.md` is updated when doc scope changes.
- [ ] Historical material is linked only with an explicit `See historical:` prefix.
- [ ] The runbook examples pass the docs verification drift guard.
- [ ] Documented validation commands still resolve to package scripts or executable script entry points.

## Documentation build and verification

```bash
npm run docs:verify
```

This builds VitePress and runs the documented route, inventory, link, source-anchor, finding-dossier, runbook-example, and validation-cadence guards, including checks that every docs:verify sub-guard script or focused Jest entry still exists.

If needed, run the raw VitePress build separately:

```bash
npm run docs:build
```

Confirm `/docs/` serves built docs in a running server build.

## Core checks

```bash
npm run typecheck
npm run build
npm test
```

For direct Jest validation without the npm wrapper:

```bash
npm run test:direct
```

## Web checks

```bash
npm run web:typecheck
npm run web:test:sweep
```

For analyst control-room coverage:

```bash
npm run web:test:analyst-ui
```

## Security and containment checks

- [ ] `/health` is public and reports runtime from the configured project root.
- [ ] `/api/*` is token-protected when `SAIVAGE_API_TOKEN` is configured.
- [ ] `/ws` rejects unauthorized connections when auth is enabled.
- [ ] `.saivage/auth-profiles.json` is blocked from file preview.
- [ ] `.saivage/saivage.json` is redacted rather than exposing literal secrets.
- [ ] Path traversal attempts are rejected by file APIs.
- [ ] Process views expose safe redacted metadata rather than raw registry internals.

## Runtime control checks

- [ ] Pause and resume behave as documented and return `RuntimeState`.
- [ ] Freeze records a freeze state and reason.
- [ ] `resume-from-freeze` restores from a valid manifest.
- [ ] Operators are not forced to infer completion from empty queues alone.

## Build and serving checks

- [ ] Built server starts through the current CLI entrypoint:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start
```

- [ ] Runtime-owning startup works when intended:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start --create-runtime
```

- [ ] SPA serves from `/`.
- [ ] Docs serve from `/docs/`.
- [ ] Built artifacts are not committed unintentionally.

## Operator workflow checks

- [ ] Dashboard shows meaningful unauthorized, reconnecting, stale, and degraded states.
- [ ] Cards detail exposes generated-file evidence and verification-command inspection.
- [ ] Agents view supports conversation inspection and linked-entity navigation.
- [ ] Files view surfaces blocked, missing, redacted, and unauthorized states intentionally.
- [ ] Debug exposes state, events, errors, supervision, MCP, and process diagnostics.
- [ ] Docs navigation is visible from the control room and does not require API auth.

## Final sign-off

- [ ] Versioning/release notes are updated as needed.
- [ ] Known follow-ups are documented explicitly.
- [ ] No release decision relies on stale design-era or generated-plan assumptions.
