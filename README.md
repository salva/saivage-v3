# Saivage v3

Saivage v3 is an autonomous multi-agent runtime for software-development work. A top-level planner decomposes goals into cards, executors perform scoped work, reviewers verify results, and the operator workspace projects cards, agents, files, timeline events, and runtime state while the Analyst chat is the ordinary mutating user surface, with direct Dashboard **Stop project** and confirmed bearer-only **Restart server** as bounded exceptions.

Configured planning and terminal workflows are genuine micro-actors. Startup compiles one immutable topology per family: lifecycle entries, configured nodes, and terminal sinks become states, while accepted outcomes become events and edges become transitions. Same-node edges are explicit external reentry. Node corrections remain hidden inside one state task. Promptless ordinary entries add no lifecycle message; STOPPED adds the discarded-position recovery statement and its configured prompt. Live state and zero-based node ordinal are transient only—there is no graph interpreter or durable cursor.

Runtime execution state is process-local. The acquired lifecycle lock supplies one stable PID/start identity for the server process, and the scheduler-owned active leaf supplies the exact current card; runtime state/status project those facts on demand without an application cache or inventory/session inference. `saivage status|pause|resume|stop` delegates only through a verified live lifecycle-lock owner's published non-null origin/auth mode; it never reads a runtime-state file or rediscovers an endpoint from config. CLI `stop` maps to resumable non-domain project containment `stop_project`, which never cancels or mutates cards. Auth-enabled confirmed `restart_server` is the separate terminal operation.

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

Initial project-card publication is allowed only when all four exact generated roots—`.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work`—are absent. `init` first creates and binds missing durable project identity, then either accepts a strictly valid existing project card, publishes from zero generated roots, or rejects the first retained exact root. After that partial-state rejection, the new identity intentionally remains so the remedy is executable: stop Saivage, run the current built `"$SAIVAGE_BIN" reset`, and retry `init`. Do not selectively delete roots or expect `init` or `start --create-runtime` to repair retained state.

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
card_processes:
  planning:
    entries:
      BACKLOG: {node: plan}
      CHANGED: {node: plan}
      BLOCKED: {node: plan}
      STOPPED: {node: recover, prompt: stopped-recovery}
    nodes:
      plan:
        role: planner
        prompt: plan
        correction_prompt: correct-plan-result
        records: [{name: status.md, updated: true}]
        edges:
          complete_direct: {target: {terminal: DONE}}
          admit_review: {target: {node: review}, prompt: plan-to-review}
          blocked: {target: {terminal: BLOCKED}}
          failed: {target: {terminal: FAILED}}
      review:
        role: reviewer
        prompt: review
        correction_prompt: correct-review-result
        records: [{name: review.md, updated: true}]
        edges:
          approved: {target: {terminal: DONE}}
          revision_required: {target: {node: plan}, prompt: review-to-plan}
          blocked: {target: {terminal: BLOCKED}}
          failed: {target: {terminal: FAILED}}
      recover:
        role: planner
        prompt: recover
        correction_prompt: correct-plan-result
        records: [{name: status.md, updated: true}]
        edges:
          complete_direct: {target: {terminal: DONE}}
          admit_review: {target: {node: review}, prompt: plan-to-review}
          blocked: {target: {terminal: BLOCKED}}
          failed: {target: {terminal: FAILED}}
  terminal:
    entries:
      BACKLOG: {node: execute}
      CHANGED: {node: execute}
      BLOCKED: {node: execute}
      STOPPED: {node: execute, prompt: stopped-recovery}
    nodes:
      execute:
        role: executor
        prompt: execute
        correction_prompt: correct-execution-result
        records: [{name: status.md, updated: true}]
        edges:
          done: {target: {terminal: DONE}}
          blocked: {target: {terminal: BLOCKED}}
          failed: {target: {terminal: FAILED}}
```

This is the authoritative default topology. Planner chooses `complete_direct` or `admit_review`; reviewer chooses `approved` or `revision_required`; child count never selects review. Edges are strict tagged objects, and reusable edge prompts are allowed only when the target is another node. Configuration is required—there is no synthesized fallback.

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

Agent prompts are customizable with file-level Markdown overrides in `.saivage/config/prompts/<cardType>/<role>.md`. Process artifacts use `.saivage/config/prompts/<cardType>/process/<identity>.md`; bundled equivalents live below `src/prompts/<cardType>/`. Every effective planner/reviewer/executor role template must include `{{contractDescription}}` exactly once and must not hard-code `emit_result` fields or values. For example:

```markdown
Perform the current configured executor node step. Follow its node/edge prompt context.
{{contractDescription}}
Use the generated Executor contract for this node exactly; the configured edge decides what follows.
```

The generated contract accepts strict parsed `{outcome,summary}`. Hidden correction keeps plain text, invalid outcomes, pending notifications, and stale/missing required records in the same node. `updated:true` compares the once-captured record version/revision baseline. Terminal routes claim before close/settlement/node cleanup/CardActor publication; intermediate routes do not claim and clean the current executor scope before the next node.

Prompt overrides are durable operator configuration: `saivage init`, `saivage reset`, and `start --create-runtime` preserve them while recreating generated state. Before deployment, audit every role override; update incompatible files to defer exactly once to `{{contractDescription}}`, or remove them. Startup fails rather than normalizing old `status` fields or outcome values.

Current card IDs use parent-local spreadsheet segments (`card-a`, `card-b`, ..., `card-z`, `card-aa`; nested parents restart at `a`). Every creation starts at `a` and directly attempts exclusive creation of each exact candidate namespace, advancing only when that `mkdir` returns `EEXIST` and never inspecting or enumerating the collision. A successful namespace claim remains consumed even if publication or linking later fails; membership begins only after complete initial publication and the parent's cumulative `children` array append.

Current card records have no `position`. The complete cumulative parent `children` snapshot is the sole linked-membership and semantic sibling-order authority, including retained tombstone links. Directory creation claims identity, complete initial publication proves the child, and only the later single parent append grants membership and places it in order. A real active reorder is likewise one parent append: requested active IDs come first and retained non-active links follow in their prior relative order; an active-order no-op writes nothing. Generic card patches cannot write `children`.

Card status rules are operation-specific, not one universal terminal taxonomy. Blocked work remains unresolved and can be re-entered by its exact parent through `activate_card` and configured `BLOCKED`; stopped work is reused only by explicit activation through `STOPPED`. See the [functional specification](docs/spec/system-specification.md) and [architecture](docs/architecture/system-architecture.md) for the authoritative contracts.

Generated card state uses exact append-only streams. The root lives at `.saivage/cards/project/{card,brief}.jsonl`; each child adds its claimed spreadsheet segment beneath the parent's `children/<segment>/` namespace, with `card.jsonl`, required `brief.jsonl`, optional `status.jsonl`/`review.jsonl`, and fixed `conversations/<role>.jsonl` files. Exclusive child-namespace creation is claim authority, while the cumulative `children` array is the sole membership authority. Card streams contain exactly `card-version` rows followed by at most one terminal `card-tombstone`; every version and tombstone retains the initial immutable card type. Tombstones make card-domain detail/history/version/diff/record reads opaque, but an already known exact role conversation remains directly readable and appendable. Records use logical versions plus contiguous stream revisions. Normal reads follow committed links and exact paths without enumerating child, version, slot, session, or temporary siblings; incomplete and complete-but-unlinked child namespaces remain invisible. The shared conversation grammar is exactly `analyst:global` plus matching planner/reviewer/executor hierarchical-card identities; canonical messages, events, logged `conversation_changed` envelopes, generic Agent APIs, live-sync frames, and the web client preserve that union, and the publisher reparses it before emission. Agent inventory derives only present eligible role files from active cards plus `analyst:global`. The former external chat integration and its dynamic Analyst identities have been removed completely. Multi-root subtree deletion performs one whole-set dependency/permission preflight and a deterministic dependent-before-dependency, child-before-parent tombstone order; an append I/O failure may leave only a valid committed prefix with no uncertain-append effects. Every replacement/first publication uses a fresh exclusive same-directory UUID temp under ordinary umask. Reset requires stop → current-built `saivage reset` → start, removes exactly `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, and `.saivage/work` wholesale, and republishes only the current format while preserving configuration, credentials, prompts, source, skills, and docs. Generic Files behavior is unchanged.

Agent inventory is durable conversation inventory, while `active | waiting | inactive` is a process-local projection of the exact currently executing role/session. Every read freezes that live map before aggregate or direct conversation acquisition. Aggregate lists omit tombstoned-card sessions; exact known-session reads retain inactive historical access. Analyst chat uses the same direct projection and represents an uncreated conversation with a null session. Runtime status no longer contains `actorRuntime.agents`; session/conversation contracts are the sole public agent-activity source.

The four reset-owned roots are also the initial-publication presence boundary. When no canonical project namespace exists, any object at one of them blocks a new root card; a non-directory or symlink at exact `.saivage/cards` is classified before child access. A valid canonical root card with a strict current-format two-kind stream is accepted directly rather than triggering a four-root health scan.

Card type is selected at creation and is immutable for the card's entire durable lifetime. Directory-owned child claiming, the two-kind card stream, removal of card `position`, complete parent-owned `children` membership/order, and the type invariant are reset-only durable changes: every rollout unconditionally requires each deployment to stop, preserve configuration, credentials, operator inputs, source, skills, instructions, and canonical documentation, run the current built `saivage reset` to replace generated persistence wholesale, and then start the current binary; no compatibility check or apparently unchanged history exempts an installation. Generated streams containing old `card-child-reservation` rows are unsupported and rejected, never compatibility-read or migrated. A successful candidate `mkdir` consumes its segment even if later publication or linking fails, and only the parent's committed cumulative `children` snapshot grants and orders membership.

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

Explicit Run selects the complete linked project-rooted running chain without installing actors, stabilizes every eligible conversation leaf-to-root, publishes every participant `stopped` leaf-to-root, and starts only project through configured STOPPED. An unmatched parent `activate_card` is settled as ordinary interrupted outcome-unknown work; terminal child results are never reconstructed or replayed. A partial reset is not atomic: the first error stops the attempt, and a later Run freshly selects the remaining running prefix or stopped project. Stopped descendants remain inactive until an exact parent `activate_card` reuses their identity through STOPPED. Intervention-ready Analyst brief/card edits and immediate-parent planner edits preserve stopped.

Conversation and app-log mutation use direct synchronous domain-owner functions. Stable role conversations are append-only: compaction never replaces a version or writes a cache. Planner, reviewer, executor, and Analyst persisted turns all use the singular prepared conversation actor. Each autonomous activation carries one exact prompt/tool budget; each Analyst submission prepares its exact rendered prompt, ordered tools, configured output request, and temperature before source publication, then retains that prepared value across tool continuations. Candidate admission uses a best-effort canonical-body byte/4 heuristic, while providers remain authoritative. One first-pass rejection backed by strict structured input-context evidence and no accepted output may force one strictly reducing compaction append and one fresh ordinary route pass under the same input identity; for an Analyst continuation, an already accepted tool effect and its one persisted result remain outside this seam and are never replayed or duplicated. A second rejection or clean no-smaller result is terminal, with no third pass or route-by-compaction expansion. Direct, nonpersisting summarizers remain unprepared, fixed to the one Registry-validated configured candidate, and receive no self-compaction or replay; summary attempts retain distinct summary-session/input app-log evidence. Durable policy stores only policy inputs plus the otherwise unreconstructible static estimate, not derived completion/threshold/window values. The minimal ordered summary-group payload and strict marker-first Analyst source format are reset-only cutovers: stop the service, preserve configuration, credentials, operator inputs, source, and documentation, run the current built `saivage reset`, and start the current binary. Old generated conversations are not migrated or compatibility-read.

The application log uses one strict direct append/read format with domain-owned post-commit effects rather than a generic persistence effect. Only a successfully appended provider exchange whose session strictly satisfies the canonical Agent conversation grammar prompts Agent refresh; `summary:*` provider evidence and event, error, control-action, and content-review rows do not.

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

`npm run validate:docs` is the docs-only validation profile: it runs the documentation drift guards (`npm run docs:verify`) and intentionally excludes `npm test` and `web:test:operator-smoke`. `npm run validate:routine` runs TypeScript typechecking, the canonical-persistence drift guard, and documentation verification; it does **not** run backend Jest. Backend/runtime changes, especially managed-process changes, therefore require explicit focused Jest plus `npm test` (or `npm run validate:release`). Central operator card-read/API changes also require explicit `npm run test:e2e`; this suite is not implied by the default backend Jest profile. `npm run validate:ui` runs web typechecking, the complete `web:test` Vitest authority, and the separate operator browser smoke; it does not use a curated sweep. `validate:ui-smoke` runs the browser smoke, while `validate:release` adds typecheck, build, default non-E2E backend Jest, browser smoke, and docs verification. The `web:test:operator-smoke` gate includes the production browser direct-load route smoke for the operator `/dashboard`, `/cards`, `/agents`, `/files`, and `/debug` views. `tests/playwright/cards-independent-scroll-selection.spec.ts` remains the normal Cards smoke authority and is included by the existing script; no separate spec path or validation profile is required. Its Cards cases cover filter-free desktop independent tree/detail scrolling, auth-banner geometry, mobile single-pane/Back behavior, one root request and baseline-only socket open per reconfiguration identity, exact lazy expansion paths, bounded cold deep-route ancestor requests and continuation after relevant refreshed membership, rapid route-reveal supersession without cancelling shared children work, disjoint hierarchy/detail authority, loaded-scope reconnect healing without hidden/unselected fan-out, retained stale data with explicit exact Retry and no automatic request, state-dependent authored-record 404 behavior and old-selection completion exclusion, exact-slot close refresh, canonical literal `to=current` diffs independent of detail ordering, detail-failure isolation, and canonical record-link navigation. Request assertions prohibit the bare `/api/cards` collection request, broad/global Cards refresh, unrelated branch reads, and unselected record/history/diff requests. Playwright always starts and owns a fresh fixed-port preview server for this gate; an existing listener causes a port-conflict failure rather than reuse of an unknown server or stale build.

The same Cards browser authority covers obsolete/missing detail recovery, one responsive **Back to Cards** action with ordinary browser history, complete selected-card teardown and invalidation/reconnect suppression, independent hierarchy refresh, and retained tree identity after detail 404.

The backend build gate and `validate:release` run a post-build compiled prompt-composition smoke after copying `src/prompts` to `dist/prompts`. Run `npm run test:compiled-prompt-composition` to repeat that focused packaged-layout check against existing build output.

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
