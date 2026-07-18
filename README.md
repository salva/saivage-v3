# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, timeline events, and runtime state while the Analyst chat is the ordinary mutating user surface, with direct Dashboard **Stop project** and confirmed bearer-only **Restart server** as bounded exceptions.

Runtime execution state is process-local. `saivage status|pause|resume|stop` delegates only through a verified live lifecycle-lock owner's published non-null origin/auth mode; it never reads a runtime-state file or rediscovers an endpoint from config. CLI `stop` maps to resumable non-domain project containment `stop_project`, which never cancels or mutates cards. Auth-enabled confirmed `restart_server` is the separate terminal operation.

`App.stop(): Promise<ShutdownReport>` is the sole production aggregate teardown API. Its App terminal coordinator synchronously attempts every admission closer, then independently attempts flat runtime, Analyst, MCP, transport, subscription, and lifecycle-lock leaves under one referenced ten-second per-leaf bound. It never enters project Stop. Reports expose only fixed component/code warnings and must be inspected by direct callers; even an empty report does not prove process exit or full OS containment. Signal/restart/startup adapters log safe warnings and preserve normal process behavior.

Provider candidate availability is live process-local routing advice and resets on process restart. Auth profiles use direct strict canonical-file reads and complete `replaceFile` publication. OAuth refresh carries the original invocation abort signal through response/body completion and the final no-await reread/replace; concurrent refresh is deliberately optimistic last-completed-write-wins with no repository, revision/CAS, mode enforcement, or persistence-health machinery.

## Quick start

Use Node.js 24 (the repository engines require `node >=24 <25` and `npm >=10 <12`, matching the GitHub Actions validation profile) on a POSIX system with Bash and POSIX process-group behavior. Build Saivage from a source checkout, then operate it from the target project directory so the project-local `.saivage/` runtime tree is created beside the work Saivage will manage:

```bash
cd <SAIVAGE_SOURCE_CHECKOUT>
npm install
npm run build
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"

TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
```

Before starting, configure model roles in `$TARGET_PROJECT/.saivage/saivage.yaml`. `start` fail-fasts at boot unless every dispatched model role (`planner`, `executor`, `reviewer`, and `analyst`) resolves. Each role resolves, in order, through one of three paths: `models.<role>` as a model name or a non-empty list for that role; `models.routing[role]` pointing to `models.profiles[<name>]`, whose `preferred` and `allowed` arrays merge; or `models.default` as a shared fallback. The minimal recommended quick-start path is the third one: a single `models.default` plus a provider entry that can serve it satisfies all four roles. Operators who want per-role or routing-profile control use the first two paths; see the Source-Derived Reference section in [the architecture summary](docs/architecture/system-architecture.md) for the full config-schema inventory.

Minimal model configuration (quick-start path only):

```yaml
models:
  default: ["gpt-4.1"]
providers:
  openai:
    models: ["gpt-4.1", "org/summary/model"]
    apiKey: "<your-api-key>"
compaction:
  enabled: true
  input_budget_tokens: 120000
  summarizer_candidate:
    provider: openai
    account: null
    model: "org/summary/model"
server:
  port: 8080
  host: "0.0.0.0"
runtime: {}
```

Direct public OpenAI GPT-5.6 through the Responses API is selected by provider capability, not by a model-name heuristic. Public OpenAI Responses uses API-key credentials only; Codex/OpenAI OAuth auth profiles are a separate `openai-codex-backend` contract and are not aliases for public OpenAI API keys.

```yaml
models:
  default: ["gpt-5.6"]
providers:
  openai:
    models: ["gpt-5.6"]
    apiKey: "<openai-api-key>"
    baseUrl: "https://api.openai.com"
    capabilities:
      transportProtocol: openai-responses
      toolsMode: native
      exclusiveToolChoiceSupport: native
      streaming: true
      responsesReasoning:
        effort: medium
compaction:
  enabled: true
  input_budget_tokens: 120000
  summarizer_candidate:
    provider: openai
    account: null
    model: "gpt-5.6"
```

Compaction is a boot requirement, not an optional feature. `init` and `start --create-runtime` create generated project/runtime state but never synthesize model, provider, or compaction policy. Omitted, `enabled: false`, incomplete, or non-configured summarizer candidates fail startup. The candidate is an exact structured identity: `account: null` selects the provider-level implicit account, while `account: "_implicit"` and `account: "_"` select those exact explicit account names and remain distinct. Model IDs may contain slashes; there is no flattened compatibility spelling or fallback summarizer route. The effective Analyst output request (`models.max_tokens.analyst`, then `models.max_tokens.default`, then 4096) must not exceed `floor(compaction.input_budget_tokens * compaction.completion_reserve_fraction)`. Startup acquires the lifecycle lock before full selected-config/environment validation, but completes that validation before any `--create-runtime` generated root-card read or publication; invalid configuration therefore creates or changes no generated root-card state. The operator must select a positive budget appropriate to the configured routes.

Agent prompts are customizable with file-level Markdown overrides in `.saivage/config/prompts/<cardType>/<role>.md`. Shipped defaults live in `src/prompts/` and are copied to `dist/prompts/`; omitted override files keep the built-in defaults. Prompt overrides are durable operator configuration: `saivage init`, `saivage reset`, and `start --create-runtime` preserve them while recreating generated state.

Generated card state uses exact append-only streams. The root lives at `.saivage/cards/project/{card,brief}.jsonl`; each child adds one opaque 28-letter segment beneath its parent's `children/<segment>/` namespace, with `card.jsonl`, required `brief.jsonl`, optional `status.jsonl`/`review.jsonl`, and fixed `conversations/<role>.jsonl` files. A parent's cumulative `children` array is the sole membership authority. Card tombstones are terminal card-stream rows and make card-domain detail/history/version/diff/record reads opaque, but an already known exact role conversation remains directly readable and appendable. Records use logical versions plus contiguous stream revisions. Normal reads follow committed links and exact paths without enumerating child, version, slot, session, or temporary siblings. The shared conversation grammar is exactly `analyst:global` plus matching planner/reviewer/executor hierarchical-card identities; canonical messages, events, logged `conversation_changed` envelopes, generic Agent APIs, live-sync frames, and the web client preserve that union, and the publisher reparses it before emission. Agent inventory derives only present eligible role files from active cards plus `analyst:global`. The former external chat integration and its dynamic Analyst identities have been removed completely. Multi-root subtree deletion performs one whole-set dependency/permission preflight and a deterministic dependent-before-dependency, child-before-parent tombstone order; an append I/O failure may leave only a valid committed prefix with no uncertain-append effects. Every replacement/first publication uses a fresh exclusive same-directory UUID temp under ordinary umask. Reset requires stop → current-built `saivage reset` → start, removes exactly `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work` wholesale, and republishes only the current format while preserving configuration, credentials, prompts, source, skills, and docs. Generic Files behavior is unchanged.

Card type is selected at creation and is immutable for the card's entire durable lifetime. Every rollout of this semantic tightening unconditionally requires each deployment to stop, run the current built `saivage reset` to replace generated persistence wholesale, and then start the current binary; no compatibility check or apparently unchanged history exempts an installation.

MCP server entries in `.saivage/saivage.yaml` use `transport: stdio` or `transport: streamable-http`.

Existing deployments must rename `.saivage/saivage.json` to `.saivage/saivage.yaml` with `mv`, not `cp`. If both files exist, startup fails and directs the operator to delete the obsolete JSON because it may still contain provider credentials. After the rename, operators may rewrite the file to idiomatic YAML and optionally add prompt override files under `.saivage/config/prompts/`.

Start Saivage from the target project directory:

```bash
SAIVAGE_API_TOKEN=test "$SAIVAGE_BIN" start
```

Open the web UI at `http://localhost:8080/`, or check health with:

```bash
curl http://localhost:8080/health
```

## Current documentation

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current functional authority | What Saivage must do from the user and runtime point of view. |
| [Operator UI specification](docs/spec/operator-ui.md) | current UI functional authority | Analyst panel, projection-oriented workspace with explicit Dashboard Stop/Restart exceptions, UI mutation boundaries, and contextual navigation. |
| [Architecture](docs/architecture/system-architecture.md) | current architecture summary | How the functional model is organized into runtime, agents, storage, API, and UI subsystems. |
| [README](README.md) | current validation and documentation authority map | Quick start, validation profiles, and this canonical documentation map. |

Explicit Run validates the durable project-rooted running-card chain, constructs fresh process-local `CardActor` owners for every card, and starts only the deepest owner with planner or executor according to card type. Before that fresh activation invokes its provider, the stable role-session owner validates the canonical conversation and locally settles the one permitted latest interrupted call with an explicit failed `tool_result`; no actor object, provider continuation, runtime-state record, or cursor is reconstructed.

Conversation and app-log mutation use direct synchronous domain-owner functions. Stable role conversations are append-only: compaction never replaces a version or writes a cache. Planner, reviewer, executor, and Analyst persisted turns all use the singular prepared conversation actor. Each autonomous activation carries one exact prompt/tool budget; each Analyst submission prepares its exact rendered prompt, ordered tools, configured output request, and temperature before source publication, then retains that prepared value across tool continuations. Candidate admission uses a best-effort canonical-body byte/4 heuristic, while providers remain authoritative. One first-pass rejection backed by strict structured input-context evidence and no accepted output may force one strictly reducing compaction append and one fresh ordinary route pass under the same input identity; for an Analyst continuation, an already accepted tool effect and its one persisted result remain outside this seam and are never replayed or duplicated. A second rejection or clean no-smaller result is terminal, with no third pass or route-by-compaction expansion. Direct, nonpersisting summarizers remain unprepared, fixed to the one Registry-validated configured candidate, and receive no self-compaction or replay; summary attempts retain distinct summary-session/input app-log evidence. Durable policy stores only policy inputs plus the otherwise unreconstructible static estimate, not derived completion/threshold/window values. The minimal ordered summary-group payload and strict marker-first Analyst source format are reset-only cutovers: stop the service, preserve configuration, credentials, operator inputs, source, and documentation, run the current built `saivage reset`, and start the current binary. Old generated conversations are not migrated or compatibility-read.

## Key concepts

| Link | Authority status | Reader guidance |
|---|---|---|
| [Functional specification](docs/spec/system-specification.md) | current | Start here for product behavior and runtime semantics. |
| [Operator UI specification](docs/spec/operator-ui.md) | current | Use for UI behavior and Analyst integration details. |
| [Architecture summary](docs/architecture/system-architecture.md) | current | Use after the functional spec for design orientation. |
| `docs/working/<date>/` | local, ignored | Temporary working documents and plans; not committed to git. |

## Verification

Run the validation profile that matches the change type. The checked-in GitHub Actions workflow at [`.github/workflows/validation.yml`](.github/workflows/validation.yml) is least-privilege and secret-free (`contents: read`, no `secrets.*` or token-like env assignments), cancels superseded runs for the same workflow/ref, sets up Node.js 24 with npm caching, and installs with `npm ci`. On push to `main` and on pull request, the `routine-docs` job runs `npm run validate:routine` and `npm run validate:docs`. A `classify-changes` job gates `backend-jest-build`, `ui-vitest`, `browser-smoke`, and `dependency-hygiene` by changed paths. For every applicable UI path, `ui-vitest` runs exactly `npm run web:typecheck && npm run web:test`; browser smoke remains a separate Playwright job. `workflow_dispatch` exposes a single `run_full_sweep` choice; when it is `true`, all path-aware jobs run regardless of changed paths. The scheduled nightly backstop (`cron: '17 5 * * *'`) runs `npm run validate:release` and the browser smoke. The `dependency-hygiene` job runs on schedule, manual full sweep, or package/workflow changes; it runs `npm run audit:security` and, on schedule or manual full sweep, `npm run deps:review`.

```bash
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
```

`npm run validate:docs` is the docs-only validation profile: it runs the documentation drift guards (`npm run docs:verify`) and intentionally excludes `npm test` and `web:test:operator-smoke`. `npm run validate:routine` runs TypeScript typechecking, the canonical-persistence drift guard, and documentation verification; it does **not** run backend Jest. Backend/runtime changes, especially managed-process changes, therefore require explicit focused Jest plus `npm test` (or `npm run validate:release`). `npm run validate:ui` runs web typechecking, the complete `web:test` Vitest authority, and the separate operator browser smoke; it does not use a curated sweep. `validate:ui-smoke` runs the browser smoke, while `validate:release` adds typecheck, build, default non-E2E backend Jest, browser smoke, and docs verification. Run Jest E2E tests explicitly with `npm run test:e2e` when requested. The `web:test:operator-smoke` gate includes the production browser direct-load route smoke for the operator `/dashboard`, `/cards`, `/agents`, `/files`, and `/debug` views. Its Cards browser case covers filter-free desktop independent tree/detail scrolling with no combined Cards scroll, auth-banner remaining-space geometry, mobile single-pane/Back behavior, exact route-derived selection and ancestor reveal, delayed keyed-detail selection preserving the mounted tree and its scroll position without another collection request, detail-failure isolation, navigation through a real canonical Card-record `[[card:...]]` link, WebSocket Cards invalidation followed by authoritative REST refetch and lifecycle-preserving selection, and a held old list racing a newly linked nested card whose accepted flat response renders through authoritative `childNodes`. Playwright always starts and owns a fresh fixed-port preview server for this gate; an existing listener causes a port-conflict failure rather than reuse of an unknown server or stale build.

To use a locally installed Chrome for release validation, run:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome npm run validate:release
```

Omitting the variable preserves the managed-browser default. This is local validation configuration only, never checked-in service configuration.

The GitHub Actions `dependency-hygiene` job runs `npm run audit:security` and, on schedule or manual full-sweep, `npm run deps:review`. Run those dependency-governance checks directly with:

```bash
npm run audit:security
npm run deps:review
```

For final stage/release gates, run the underlying checks directly when requested:

```bash
npm run docs:verify
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run web:test:operator-smoke
```

The canonical docs listed above are current authority. `npm run validate:docs` is the documentation drift gate for keeping those docs, links, source anchors, validation cadence, and source-derived route/tool/config inventories in sync.
