# Saivage v3 — Installation Guide

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/cli.ts:1
-->

This guide walks through installing and running Saivage v3 from a clean checkout.

## Prerequisites

- **Node.js** >= 20 (20.x or 22.x LTS recommended)
- **npm** >= 9 (ships with Node.js 20)
- **TypeScript** — compiled by the project; no global install needed
- **Git** — for cloning the repository

Verify your environment:

```bash
node --version   # should print v20.x.x or v22.x.x
npm --version    # should print 9.x.x or 10.x.x
```

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd saivage-v3
```

### 2. Install dependencies

```bash
npm install
```

> **⚠ IMPORTANT — NODE_ENV gotcha**: npm's default behaviour is to skip
> `devDependencies` when `NODE_ENV` is set to `production` in your shell
> environment. If your install is missing `jest`, `typescript`,
> `pino-pretty`, or other dev tools, check your environment first:
>
> ```bash
> echo $NODE_ENV
> ```
>
> If it prints `production`, either unset it or override it for the install:
>
> ```bash
> unset NODE_ENV && npm install
> # or
> NODE_ENV=development npm install
> ```

### 3. Build the project artifacts

Build the compiled server, VitePress docs, and Web UI from the repo root:

```bash
npm run build
```

This produces:

- `dist/` — compiled TypeScript runtime and CLI
- `docs/.vitepress/dist/` — built operator docs served at `/docs/`
- `web/dist/` — built Web Control Room SPA served at `/`

If you only need the server/runtime JS during development, `npx tsc` still works as a narrower compile step, but `npm run build` is the canonical release-candidate build path.

### 4. Configure the environment

#### Required

- **`SAIVAGE_API_TOKEN`** — the bearer token used for authenticating API requests. Without this, the server runs in an open (no-auth) mode. For any production or multi-user use, **set this**.

```bash
export SAIVAGE_API_TOKEN="your-secret-token-here"
```

#### Optional

- **`LOG_LEVEL`** — pino logger level. Defaults to `info`. Set to `debug` or `trace` for more verbosity.
- **`NODE_ENV`** — set to `development` to enable pretty-printed logs (pino-pretty). Otherwise logs are JSON.

```bash
export LOG_LEVEL="debug"
export NODE_ENV="development"
```

### 5. Create the project configuration

Create `.saivage/saivage.json` in the project root. At minimum, this file must contain model and provider configuration so agents can invoke LLMs.

Minimal example:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "models": {
    "planner": ["claude-sonnet-4-20250514"],
    "executor": ["claude-sonnet-4-20250514"],
    "reviewer": ["claude-sonnet-4-20250514"],
    "default": ["claude-sonnet-4-20250514"]
  },
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": ["claude-sonnet-4-20250514"],
      "priority": 10
    }
  }
}
```

See **[CONFIGURATION.md](configuration.md)** for the full config reference with all sections and examples.

> **Secret handling**: Fields named `apiKey`, `apiToken`, `botToken`, etc. can use `${ENV_VAR}` syntax to reference environment variables instead of hardcoding secrets. The API server redacts literal secrets in `.saivage/saivage.json` when serving config through `/api/config`.

### 6. Start the server

Use the CLI entrypoint:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start
```

Or, after installing/linking the package bin:

```bash
SAIVAGE_API_TOKEN=test saivage start
```

The server listens on the configured host and port (default `0.0.0.0:8080`). Add `--create-runtime` if you also want to start the active runtime dispatch loop:

```bash
SAIVAGE_API_TOKEN=test ./bin/saivage.js start --create-runtime
```

### 7. Verify it's working

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "project": "saivage-v3",
  "runtime": "idle"
}
```

The `runtime` field reflects the actual runtime state read from `.saivage/runtime/state.json`. It will show `idle` or `unknown` on a fresh project start depending on whether the runtime state has been initialized yet.

## First Run

On first startup:

1. The server reads `.saivage/saivage.json` for configuration.
2. If the runtime dispatch loop is started, it creates or updates `.saivage/runtime/state.json`.
3. If `mcpServers` with `autostart: true` are configured, the MCP manager starts those servers.
4. If a Telegram bot token is configured, the bot starts polling.
5. If built artifacts exist, the server serves the Web Control Room at `/` and docs at `/docs/`.

## Development Mode

For development with automatic rebuild on changes, you can use `tsc --watch`:

```bash
# Terminal 1: watch TypeScript
npx tsc --watch

# Terminal 2: run server (restart manually when you want to pick up changes)
SAIVAGE_API_TOKEN=test ./bin/saivage.js start
```

## Next Steps

- Create a goal card via card creation command — see **[OPERATION.md](operation.md)** for API usage.
- Open the web UI at `http://localhost:8080/` (if you built the web frontend).
- Read **[CONFIGURATION.md](configuration.md)** to configure models, providers, MCP servers, Telegram, and notifications.
- Read **[OPERATION.md](operation.md)** to learn about runtime management, backup, and recovery.
