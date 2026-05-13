# Saivage v3 — Release Checklist

A step-by-step checklist for preparing a release candidate.

## Pre-Release Verification

### Automated Checks

- [ ] **All tests pass**
  ```bash
  npm test
  ```
  Expected: all suites pass, output shows `Tests: N passed, N total`.

- [ ] **TypeScript typecheck passes**
  ```bash
  npm run typecheck
  ```
  Expected: no output (zero errors, zero warnings).

- [ ] **Web UI typecheck passes**
  ```bash
  npm run web:typecheck
  ```
  Expected: no output (zero errors, zero warnings). Runs `tsc --noEmit` in the `web/` SPA sub-project.

- [ ] **Web UI tests pass**
  ```bash
  npm run web:test:sweep
  ```
  Expected: all view suites and store suites pass. This is the primary web SPA verification sweep. See `package.json` for focused suites (e.g. `web:test:debugview`, `web:test:stores`) when iterating on a single area.

- [ ] **Lint passes**
  ```bash
  npm run lint
  ```
  Expected: no output (zero errors, zero warnings).

- [ ] **Format check passes** (if configured)
  ```bash
  npm run format
  ```
  Expected: no output (all files match prettier config).

### Security Review

- [ ] **No secrets leaked in API responses**
  ```bash
  # Verify auth-profiles.json is blocked
  curl -sv http://localhost:8080/api/files/content?path=.saivage/auth-profiles.json 2>&1 | grep "403"

  # Verify saivage.json secrets are redacted
  curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/config | grep -c "REDACTED"
  ```
  The config API must NOT return literal API keys — only `[REDACTED]` placeholders or `${ENV_VAR}` references.

- [ ] **Auth token is set in environment for production**
  ```bash
  echo $SAIVAGE_API_TOKEN
  ```
  Must not be empty. A production server with no token runs in open mode.

- [ ] **Path traversal protection verified**
  ```bash
  # Should return 403
  curl "http://localhost:8080/api/files/content?path=../etc/passwd"
  curl "http://localhost:8080/api/files/content?path=.saivage/../etc/passwd"
  ```

- [ ] **Content supervisor can be enabled**
  Verify `security.injectionScanner` in `.saivage/saivage.json` is `true` for production.

- [ ] **WebSocket rejects unauthenticated connections**
  Attempt a WebSocket connection without a token — the upgrade must be rejected.

### Documentation Check

- [ ] **INSTALL.md** is up to date with current prerequisites and steps.
- [ ] **CONFIGURATION.md** reflects the actual config schema (verify against `src/agents/config-schema.ts`).
- [ ] **OPERATION.md** covers start/stop, runtime states, backup, and recovery.
- [ ] **TROUBLESHOOTING.md** covers known issues with real error messages.
- [ ] **RELEASE-CHECKLIST.md** (this file) is current.
- [ ] **OPERATOR-RUNBOOK.md** covers daily operations and incident response.
- [ ] **README.md** links to all docs in `docs/`.

## Build and Packaging

- [ ] **TypeScript compilation succeeds**
  ```bash
  npx tsc
  ```
  Check that `dist/` directory is populated with compiled JS files.

- [ ] **Web UI builds** (if including web frontend)
  ```bash
  cd web && npm run build && cd ..
  ```
  Check that `web/dist/` directory exists with `index.html` and assets.

- [ ] **No stale state in the repository**
  ```bash
  git status
  ```
  Ensure `.saivage/` and `.saivage-work/` are in `.gitignore` and not committed. No `dist/` files should be committed (handled by `.gitignore`).

- [ ] **Package dependencies are clean**
  ```bash
  npm ls --depth=0
  ```
  No extraneous or missing dependencies.

## Clean Checkout Test

Perform this on a fresh clone to simulate a new user's experience:

- [ ] **Clone to a fresh directory**
  ```bash
  git clone <repo> /tmp/saivage-test
  cd /tmp/saivage-test
  ```

- [ ] **npm install succeeds**
  ```bash
  npm install
  ```
  Must complete without errors.

- [ ] **TypeScript compiles**
  ```bash
  npx tsc
  ```

- [ ] **Create minimal config**
  ```bash
  mkdir -p .saivage
  cat > .saivage/saivage.json << 'EOF'
  {
    "server": { "host": "0.0.0.0", "port": 8080 }
  }
  EOF
  ```

- [ ] **Server starts and responds**
  ```bash
  SAIVAGE_API_TOKEN=test node dist/src/server/server.js &
  sleep 2
  curl http://localhost:8080/health
  ```

- [ ] **Health endpoint returns 200**
  Expected response:
  ```json
  {
    "status": "ok",
    "version": "0.1.0",
    "project": "saivage-v3",
    "runtime": "idle"
  }
  ```

- [ ] **API endpoints are accessible**
  ```bash
  curl -H "Authorization: Bearer test" http://localhost:8080/api/cards
  # → {"cards":[],"total":0}

  curl -H "Authorization: Bearer test" http://localhost:8080/api/state
  # → {"runtime":{...},"cardIndex":{"total":0,...}}
  ```

- [ ] **Web UI serves** (if built)
  ```bash
  curl http://localhost:8080/
  # → HTML of index.html
  ```

- [ ] **Clean up test instance**
  ```bash
  kill %1
  rm -rf /tmp/saivage-test
  ```

## Final Checklist

- [ ] Version number in `package.json` is updated.
- [ ] Changelog or release notes are written (if applicable).
- [ ] All items above are checked.
- [ ] Release is tagged in git (if applicable).

## Sign-Off

| Date | Release Version | Verified By | Notes |
|---|---|---|---|
| | | | |
