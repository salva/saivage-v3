# Live GetRich v2 Launch and Playwright Issues

Date: 2026-06-24

Target: `saivage-v3-getrich-v2` at `http://10.0.3.170:8080`, service `saivage-v3-getrich.service`.

## Commands Run

```bash
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS --max-time 5 http://10.0.3.170:8080/health
curl -fsS --max-time 5 http://10.0.3.170:8080/health/ready
npm run web:test:live-getrich-v2
```

The live suite requires a reachable deployment. It defaults to the target above; set `SAIVAGE_LIVE_BASE_URL=http://host:port` to override the deployment URL.

## Launch Result

- Host build passed.
- Container was already running.
- Service started successfully and reported `active`.
- `/health` returned `{"status":"ok","version":"0.1.0","project":"saivage-v3"}`.
- `/health/ready` returned `status: "ready"` with `api`, `runtime`, and `mcp` available.

## Node Runtime Fix

Updated on 2026-06-24 after the initial report:

- Installed the official Node.js `v24.16.0` runtime inside the container under `/opt/node-v24.16.0`.
- Added `/usr/local/bin/node`, `/usr/local/bin/npm`, and `/usr/local/bin/npx` symlinks to the Node 24 installation.
- Added a systemd drop-in at `/etc/systemd/system/saivage-v3-getrich.service.d/node24.conf` so `saivage-v3-getrich.service` runs with `/opt/node-v24.16.0/bin/node`.
- Restarted the service and verified `/proc/<MainPID>/exe` resolves to `/opt/node-v24.16.0/bin/node`.
- Verified `node --version` is `v24.16.0` and `npm --version` is `11.13.0` for both `root` and `salva` inside the container.
- Verified `/health` and `/health/ready` still return healthy responses.

## Playwright Result

The live Playwright suite ran 66 tests:

- Passed: 64
- Failed: 2

Failure artifacts:

- `tmp/playwright-live-results/live-getrich-v2-coverage-s-79feb-tent-for-an-in-project-path-chromium/error-context.md`
- `tmp/playwright-live-results/live-getrich-v2-coverage-s-79feb-tent-for-an-in-project-path-chromium/trace.zip`
- `tmp/playwright-live-results/live-getrich-v2-saivage-v3-37f99-gured-providers-and-routing-chromium/error-context.md`
- `tmp/playwright-live-results/live-getrich-v2-saivage-v3-37f99-gured-providers-and-routing-chromium/trace.zip`

## Issues Found

### 1. Service starts unauthenticated on `0.0.0.0`

The systemd service started without `SAIVAGE_API_TOKEN`, and the server logs report development mode while binding to all interfaces:

```text
SAIVAGE_API_TOKEN is not set. Server is running in DEVELOPMENT MODE with auth disabled.
Binding to 0.0.0.0 without SAIVAGE_API_TOKEN. All API endpoints are unauthenticated.
Server listening at http://10.0.3.170:8080
```

Impact: all API endpoints are reachable without authentication on the container network.

Likely fix: configure the deployment service with an environment file or systemd `Environment=SAIVAGE_API_TOKEN=...`, then restart and verify protected routes require bearer auth. Do not place bearer tokens in URLs.

### 2. Resolved: container runtime Node version did not match repo engines

The service unit runs:

```text
ExecStart=/opt/node-v24.16.0/bin/node /opt/saivage-v3/bin/saivage.js start --host 0.0.0.0 --port 8080
```

Inside the container:

```text
node v24.16.0
npm 11.13.0
```

But `package.json` requires:

```json
"node": ">=24 <25",
"npm": ">=10 <12"
```

Status: fixed for the live deployment. The Ubuntu package `nodejs` remains installed, but `/usr/local/bin` and the service drop-in now point the deployment at Node 24.

### 3. Live providers API returns shortened `opencode-go` model ids while the test expects provider-qualified ids

Failed test:

```text
tests/playwright/live-getrich-v2/live-getrich-v2.spec.ts:36
health and config endpoints expose the configured providers and routing
```

Observed from `/api/providers`:

```json
{
  "opencodeGoModels": ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"]
}
```

The test expects:

```text
["glm-5.1", "moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v4-pro"]
```

Impact: either the live config/API now intentionally canonicalizes model ids, or the route is dropping provider namespaces. The test and contract need to be reconciled.

Likely fix: decide whether `/api/providers` should expose display ids or fully qualified provider model ids, then update the API/config or the live Playwright expectation accordingly.

### 4. Live GetRich v2 `pyproject.toml` package name is `getrich`, but the live test expects `getrich-v2`

Failed test:

```text
tests/playwright/live-getrich-v2/live-getrich-v2-coverage.spec.ts:167
GET /api/files/content returns file content for an in-project path
```

Observed file content includes:

```toml
[project]
name = "getrich"
description = "GetRich v2 research framework"
```

The test expects the fetched file content to contain `getrich-v2`.

Impact: this looks like live fixture drift rather than a file-browser failure. The endpoint returned the requested in-project file successfully, but the assertion is tied to an older project-name expectation.

Likely fix: either rename the package to `getrich-v2` if that is the intended project identity, or update the Playwright assertion to validate stable file-browser behavior instead of a package-name string.
