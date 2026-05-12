# Saivage v3 — Installation Guide

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
> environment.  If your install is missing `jest`, `typescript`,
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

### 3. Build the Web UI (optional)

If you want the Web Control Room (Vue SPA served by the same process):

```bash
cd web
npm install
npm run build
cd ..
```

After building, the `web/dist/` directory will exist and the server will automatically serve it as a single-page application at `/`.

If you skip the web UI build, the API server still works fine — you can interact with it entirely via `curl` or any HTTP client.

### 4. Compile TypeScript

Saivage v3 is written in TypeScript (ES modules, NodeNext resolution). Compile with:

```bash
npx tsc
```

This writes compiled JavaScript to `dist/`. The main server entry point is `dist/src/server/server.js`.

There is no `npm run build` script in the root package — `npx tsc` is the canonical build command.

### 5. Configure the environment

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

### 6. Create the project configuration

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

### 7. Start the server

```bash
SAIVAGE_API_TOKEN=test node dist/src/server/server.js
```

The server listens on the configured host and port (default `0.0.0.0:8080`).

### 8. Verify it's working

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

The `runtime` field reflects the actual runtime state read from `.saivage/runtime/state.json`. It will show `idle` on a fresh project start.

## First Run

On first startup:

1. The server creates `.saivage/runtime/state.json` with default idle state.
2. The runtime lock file is created at `.saivage-work/tmp/runtime/runtime.lock`.
3. The card store initializes empty (no cards exist yet).
4. If `mcpServers` with `autostart: true` are configured, the MCP manager starts those servers.
5. If a Telegram bot token is configured, the bot starts polling.

## Development Mode

For development with automatic rebuild on changes, you can use `tsc --watch`:

```bash
# Terminal 1: watch TypeScript
npx tsc --watch

# Terminal 2: run server (restart manually when you want to pick up changes)
SAIVAGE_API_TOKEN=test node dist/src/server/server.js
```

## Next Steps

- Create a goal card via `POST /api/cards` — see **[OPERATION.md](operation.md)** for API usage.
- Open the web UI at `http://localhost:8080/` (if you built the web frontend).
- Read **[CONFIGURATION.md](configuration.md)** to configure models, providers, MCP servers, Telegram, and notifications.
- Read **[OPERATION.md](operation.md)** to learn about runtime management, backup, and recovery.
