# Getting started

Status: non-authoritative guide. Contracts and exact behavior are owned by the
[System specification](../spec/system-specification.md), the
[Operator UI specification](../spec/operator-ui.md), and the
[Operator runbook](../runbook/index.md).

This guide takes you from nothing to a running Saivage instance working on
your first objective. Configuration details live in the
[Configuration guide](./configuration.md); day-to-day use lives in
[Operating a project](./operating.md).

## What you need first

- **Node.js 24** (`node >=24 <25`, `npm >=10 <12`).
- **A target project directory** — the codebase or workspace Saivage will work
  on. It can be empty (Saivage can create the project from a specification)
  or an existing repository.
- **A provider** — an OpenAI-compatible chat-completions endpoint and API key
  for the models Saivage will use.
- **An isolated environment** — Saivage is designed to run inside an
  externally isolated container in which its agents are trusted and may use
  root. The deployment, not Saivage, provides that isolation. Read the
  [trust model](../architecture/system-architecture.md#deployment-and-trust-model)
  before exposing any instance to a network.

The fastest robust installation is the guided LXC procedure written for an AI
assistant to execute on your host:
[README-IF-YOU-ARE-AN-AI.md](https://github.com/salva/saivage-v3/blob/master/README-IF-YOU-ARE-AN-AI.md).
The manual equivalent is below.

## 1. Build Saivage

```bash
cd <saivage-source-checkout>
npm ci
(cd web && npm ci)
npm run build
```

`npm run build` compiles the server, the web control room, and this
documentation site, and runs the build smoke tests. Point `SAIVAGE_BIN` at
the checkout's `bin/saivage.js` from now on.

## 2. Initialize the target project

```bash
TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"
"$SAIVAGE_BIN" init
```

`init` materializes the project layout under `.saivage/`: the configuration
file `saivage.yaml`, the bundled prompt tree under `.saivage/config/prompts/`,
and the root project card. Use `init --profile classic-typed` **before any
config exists** if you want the typed card-type workflows instead of the
classic set (see [Configuration](./configuration.md#card-types)).

## 3. Configure a provider

Edit `.saivage/saivage.yaml`. At minimum, point the model routes at your
provider and set the compaction summarizer to a model with a large context
window. With the default classic template, replace the placeholder routes and
add your provider:

```yaml
providers:
  my-provider:
    apiKey: ${MY_PROVIDER_API_KEY}
    baseUrl: https://api.example.com/v1
    capabilities:
      transportProtocol: openai-chat-completions
      toolsMode: native
      exclusiveToolChoiceSupport: native
      contextWindowTokens: 400000
      maxOutputTokens: 65536
    models: [my-model]

models:
  routes:
    analyst:  { candidates: [my-model], temperature: 0.7, max_tokens: 4096 }
    oversight: { candidates: [my-model], temperature: 0.2, max_tokens: 4096 }
    planner:  { candidates: [my-model], temperature: 0.7, max_tokens: 4096 }
    reviewer: { candidates: [my-model], temperature: 0.2, max_tokens: 4096 }
    executor: { candidates: [my-model], temperature: 0.3, max_tokens: 8192 }

compaction:
  enabled: true
  context_utilization_fraction: 0.80
  trigger_fraction: 0.90
  tail_fraction: 0.25
  summarizer_candidate: { provider: my-provider, account: null, model: my-model }
```

Export the key in the service environment; `${VAR}` references are resolved
at startup. The full key-by-key walkthrough, including accounts, failover,
and MCP servers, is in the [Configuration guide](./configuration.md).

## 4. Start the server

```bash
export SAIVAGE_API_TOKEN   # bearer token for the operator UI and API
"$SAIVAGE_BIN" start --host 127.0.0.1 --port 8080
```

Check the public probes:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

The bearer token is sent only in the `Authorization` header, never in a URL:

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/processes
```

## 5. Open the control room

Browse to `http://localhost:8080/` and enter your token. The
[operating guide](./operating.md) tours every panel. The built documentation
is served by the same instance at `http://localhost:8080/docs/`.

## 6. Give it your first objective

Use the Analyst conversation on the right of the control room. Describe what
the project must achieve — paste or point to the specification — then ask it
to start:

> This project's objective is described in SPEC.md at the repository root.
> Read it, propose the root brief, and start the project.

The Analyst can edit the root brief with you and then calls `start_project`.
From that moment the runtime plans and executes autonomously: watch the card
tree grow in **Cards**, live agent sessions in **Agents**, and durable
evidence in **Files**. Saivage keeps working between your visits and asks
for you only when a real decision is missing — see
[Operating a project](./operating.md).

## Where to go next

- [Configuration](./configuration.md) — every `saivage.yaml` key explained.
- [Operating a project](./operating.md) — the control room, steering, and
  long-run behavior.
- [Operator runbook](../runbook/index.md) — deployment, lifecycle, recovery,
  and reset procedures (authoritative).
