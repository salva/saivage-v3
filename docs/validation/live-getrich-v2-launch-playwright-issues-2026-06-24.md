# Historical record: Live GetRich v2 launch and Playwright issues

**Archived historical execution record. Not current validation guidance.**

Date: 2026-06-24

The deployment-coupled Playwright suite described here was removed from
executable validation on 2026-09-02. It has no current command or default
deployment. See the [archive marker](https://github.com/salva/saivage-v3/blob/master/tests/playwright/live-getrich-v2/README.md)
for the archive decision, former prerequisites, authentication assumptions,
mutation warning, and Git-history provenance.

The observations below describe only the 2026-06-24 run against the then-target
`saivage-v3-getrich-v2` deployment at `http://10.0.3.170:8080`, using service
`saivage-v3-getrich.service`. They must not be used as launch or rerun
instructions, and they do not establish that the deployment remains reachable
or compatible.

## Historical launch result

- The host build passed.
- The container was already running.
- The service started successfully and reported `active`.
- `/health` returned `{"status":"ok","version":"0.1.0","project":"saivage-v3"}`.
- `/health/ready` returned `status: "ready"` with `api`, `runtime`, and `mcp`
  available.

## Historical Node runtime correction

The initial report was updated on 2026-06-24 after the deployment runtime was
corrected:

- The official Node.js `v24.16.0` runtime was installed inside the container
  under `/opt/node-v24.16.0`.
- `/usr/local/bin/node`, `/usr/local/bin/npm`, and `/usr/local/bin/npx`
  symlinks selected that installation.
- A systemd drop-in made `saivage-v3-getrich.service` run with
  `/opt/node-v24.16.0/bin/node`.
- The service executable and the `node`/`npm` versions were verified as Node
  `v24.16.0` and npm `11.13.0` for both `root` and `salva`.
- The health endpoints remained healthy.

Those versions matched the then-current package engine requirements: Node
`>=24 <25` and npm `>=10 <12`.

## Historical Playwright result

The removed suite ran 66 tests: 64 passed and 2 failed. Temporary Playwright
error contexts and traces were written under `tmp/playwright-live-results/`;
those local artifacts were not durable validation authority.

## Findings from that run

### 1. Service started unauthenticated on `0.0.0.0`

The systemd service started without `SAIVAGE_API_TOKEN`, and its logs reported
development mode with authentication disabled while binding to all interfaces.
All API endpoints were consequently reachable without authentication on the
container network.

The archived tests sent no bearer header and therefore depended on that
auth-disabled, externally isolated setup. Ordinary current deployments require
an explicit authentication design, and bearer tokens must never be placed in
URLs.

### 2. Provider/model expectation had drifted

One archived assertion expected provider-qualified `opencode-go` model IDs,
while `/api/providers` returned shortened IDs:

```json
{
  "opencodeGoModels": ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"]
}
```

The former expectation was:

```text
["glm-5.1", "moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v4-pro"]
```

At the time, it was unclear whether the API intentionally exposed display IDs
or had dropped provider namespaces. This dated discrepancy is preserved only
as provenance; it is not a current API decision.

### 3. GetRich package-name expectation had drifted

Another archived assertion expected `getrich-v2`, while the fetched
`pyproject.toml` contained:

```toml
[project]
name = "getrich"
description = "GetRich v2 research framework"
```

The file endpoint had returned the requested in-project content successfully.
The failure therefore appeared to be fixture drift rather than a file-browser
failure. This dated discrepancy is likewise historical rather than a current
expectation.
