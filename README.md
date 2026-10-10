# Saivage v3

Managed process evidence can become **unavailable** after lost group authority.
Leader exit and EOF do not confirm cleanup; failed scopes remain blockers and later
activations cannot take ownership. See [operator diagnosis](docs/runbook/index.md#unavailable-process-evidence).

### Inspecting screenshots

An agent can use `run_command` to save a **non-secret** screenshot in the project,
then call `view_image({"path":"screenshots/settings.png"})`. Command output alone
never attaches an image. Selected Analyst, Executor and Reviewer surfaces include
this tool; custom agents must opt in. Image input requires a compatible Responses
or Codex primary **and summary** route (including `gpt-6.1-sol` and `gpt-6-astra`);
Chat remains text-only. The default longest side is 1600, with integer 1..16384 or
`"original"` as `max_dimension`. Local original does not force provider-original
processing. Successful tool results use optional ordered text/image `content`;
the UI offers **Inspect image** for each typed selection at its content position.
The shared viewer provides **Fit** (never upscaled) and **1:1**; Escape returns
to the same conversation position. Pixels are recorded model-input snapshots,
not proof of delivery or perception. Files uses the same viewer for eligible
static PNG/JPEG/WebP, labeled **Current source**, not the recorded snapshot.
`view_image` selects one workspace snapshot. Configured `mcp_tool_call` also
preserves ordered native text and static PNG/JPEG/WebP images, without a file round
trip. Its local `max_dimension` uses the same default and bounds. Complete results
are bounded, never truncated: wire 48 MiB, aggregate source images 32 MiB,
projected non-image text/JSON 1 MiB. Selected Analyst/Executor tools can start a
configured official Playwright MCP server, discover exact schemas and invoke native
screenshots (`scale:'css'`, no filename). See the [pinned browser recipe](docs/runbook/index.md#configured-browser-lifecycle).
Reviewer requires explicit admission; Oversight has no MCP. One server shares a
disposable context, lost on stop/active cancellation. Pixels cannot be certified secret-free.
Configured stdio servers receive the admitted project workspace through negotiated
`roots/list` throughout the connection lifetime, including discovery and idle intervals.

Conversation index/genesis/envelope now use strict **format 7** for loss-tolerant
active-memory maintenance, retaining the ordered-content contract introduced in 6.
Format 6 or earlier/mixed
state stays a stopped blocker: adoption needs a separately consented complete
reset or explicitly owner-requested external offline migration, never automatic
conversion. Snapshots grow with observations and are included in complete backups;
there is no GC. Installing Sharp requires optional native dependencies (see the
[runbook](docs/runbook/index.md#image-snapshots-and-native-dependencies)).

Conversation maintenance first preserves useful ordinary summaries. If bounded
construction cannot produce a qualifying candidate, it may publish a fixed notice
declaring omission of earlier compactable narrative and inherited summary prose.
Protected instructions, canonical facts, exact suffix and frozen current context
remain; indexed history is not automatically restored to active memory. Known
successful maintenance returns to ordinary primary admission, not task approval.
See [maintenance limits and evidence](docs/runbook/index.md#prepared-conversation-compaction)
and the [format cutover](docs/architecture/durable-format-changes.md).

Saivage is autonomous software engineering built for the long run. Give it the
specification for a software project and it carries the work from
specification to accepted delivery — planning, implementing, testing, and
reviewing on its own, over long runs, with evidence for every step — asking
for you only when a real decision is missing. The operator observes
everything through a web control room and steers through a single Analyst
conversation.

Conversation tails track exact immutable segment identity, not just the displayed
ordinal; refreshed baselines replace rather than mix after a changed selection.
See the [conversation contracts](docs/spec/operator-ui-contracts.md#6-conversation-readers).
Each conversation has one reading scroll surface, with compacted context, activation
index and Technical details initially closed. Full safe summary, retained instructions,
facts and source/continuation remain inspectable; recorded system text closes at its
source position. Segment history selects exact retained history, not a stitched transcript.
Optional **Currently configured instructions** composes all current session bindings
from configuration loaded by the server, not historical instructions or unactivated disk
edits. Open to read, Refresh explicitly, close to discard; this is not an exact-request viewer.
Matched tool exchanges use exact session/source-input/call identity, not provider call ID alone,
and appear once at the request position, including nonadjacent results;
**Result recorded later** discloses interleaving, and both source anchors, coordinates and
times remain inspectable. Compact friendly action/abbreviated-target/honest-outcome summaries
expand to complete Request/Result detail and independent output heads; safe-original
disclosures copy complete public values.
Safe-original image copy stays descriptor-only. Settlement need not mean process completion,
acceptance, delivery or perception. Repair directives do not prove repair; interruption
notices keep effects uncertainty visible. Scroll-away pauses following; Analyst's explicit
Pause survives its one-shot Jump to latest, unlike ordinary unpaused following.

Dedicated JSON data inspection uses consistent safe, readable lexical highlighting
without changing supplied text or existing copy payloads. Files JSON preserves the
exact received safe text. See the
[shared JSON display contract](docs/spec/operator-ui-contracts.md#shared-json-data-display).

Start with the [documentation overview](docs/overview.md), the
[getting-started guide](docs/guides/getting-started.md), or the
[documentation site](https://salva.github.io/saivage-v3/) (also served by
every running instance at `/docs/`).

For an AI-guided LXC installation, use the subordinate
[AI setup procedure](README-IF-YOU-ARE-AN-AI.md). It applies the canonical
contracts linked below; it is not an independent product or operations
authority.

## Quick start

Saivage is designed for an externally isolated LXC container in which trusted
agents may have root access. See the
[architecture trust model](docs/architecture/system-architecture.md#deployment-and-trust-model)
before deployment. For a first agent-run trial, use a disposable target (such
as a controlled copy) inside a trusted, externally isolated VM/container. A
copy protects the original working tree, not the host; loopback binding limits
listeners but does not contain agent
commands or untrusted local/browser origins. Local builds and tests outside LXC
remain supported. This trial deliberately disables operator authentication;
follow the [runbook](docs/runbook/index.md) for deployment decisions.

Use Node.js 24. The package engines require `node >=24 <25` and `npm >=10 <12`,
matching GitHub Actions. Build from a source checkout, then initialize and start
from the target project:

```bash
cd <SAIVAGE_SOURCE_CHECKOUT>
npm ci
(cd web && npm ci)
npm run build
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"

TARGET_PROJECT="/absolute/path/to/target-project"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
# Before starting, configure a provider and point the model routes and
# compaction summarizer at it; the bundled template ships no provider.
# Follow the getting-started guide for the example configuration.
env -u SAIVAGE_API_TOKEN "$SAIVAGE_BIN" start --host 127.0.0.1 --port 8080
```

The [getting-started guide](docs/guides/getting-started.md) walks through a
complete minimal configuration and first objective, and the
[configuration guide](docs/guides/configuration.md) documents every key. The [system specification](docs/spec/system-specification.md#8-lifecycle-lock-and-cli)
owns startup options and precedence; the [runbook](docs/runbook/index.md)
owns deployment, configuration cutovers, lifecycle operations, recovery, and
reset, including its [command-environment guidance](docs/runbook/index.md#command-environment).
Successful startup and offline workflow loads report redacted advisory
missing-environment warnings; see the [configuration guide](docs/guides/configuration.md).
Successful fresh startup settles interrupted linked cards before listener/readiness
and leaves execution stopped. Before card settlement, configured-global Analyst
and established Oversight final unmatched tool calls receive uncertainty-only
failed mates, without new submissions, checks, or global recovery notices; see the
[global startup guidance](docs/runbook/index.md#configured-global-startup-settlement-and-invalid-history).
An explicit Run starts project work. Same-process
project Stop leaves any durable running chain for the next Run. See the
[runbook lifecycle guidance](docs/runbook/index.md#activation-ownership-and-runtime-halt).
For steering, the Analyst can queue normal context while work runs. Exceptional
urgent context may stop exact active work and re-enter its recipient workflow;
enqueue and interruption do not promise delivery or action. Without an eligible
running owner it only queues until a later explicit Run; Pause still needs
explicit Resume. See the [notification contract](docs/spec/system-specification.md#7-urgent-notification-ordering-implemented-shared-contract).

For that auth-disabled trial, open the UI at `http://localhost:8080/` and the
built documentation at `http://localhost:8080/docs/`, or check the public probes:

The control room has **Cockpit**, **Files**, and **System**. The card cockpit
keeps its tree and **Overview**, **Conversations**, **Records & History**, and
**Evidence** facets together; the Analyst panel stays available for steering. Submitted [workspace focus](docs/spec/system-specification.md) is advisory context captured at Send, not continuous observation of the screen.
See the authoritative [operator UI contracts](docs/spec/operator-ui-contracts.md).
For selected-segment activation markers and bounded direct-control Events, see
[exact evidence navigation](docs/runbook/index.md#open-exact-activation-evidence);
the new durable event kind requires [incompatible adoption](docs/runbook/index.md#direct-runtime-control-event-adoption).
Analyst submissions use REST only (`POST /api/chat`); WebSocket carries live observation subscriptions and freshness hints, not submissions or turn acknowledgements.

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

**Separate bearer-enabled API deployment example (not UI login):** the control
room has no token-entry screen, so a bearer-enabled deployment presents
unauthorized views in the browser. For a protected API request, send the bearer
token only in the `Authorization` header, never in a URL. See the
[runbook's authentication guidance](docs/runbook/index.md#operator-rest-authentication).

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/processes
```

## Current documentation

Failed-provider request diagnostics are disabled by default. Explicit
`saivage start --failed-provider-diagnostics <UUID>` opts into finite, private local
capture (16 failure slots/one hour, at most 8 MiB per file). Project/prompt text
remains sensitive after projection: it is not a secret-free export, complete raw
request, replay fixture or receipt. New captures use diagnostic v2/policy-2; retained
v1 files do not gain its privacy guarantees. See the [diagnostics runbook](docs/runbook/index.md#private-failed-provider-request-diagnostics)
before enabling, inspecting or rolling back over retained captures.

New here? Follow the overview and guides first. Exact rules and procedures live
in the authority pages below; the guides summarize them rather than replacing
them.

| Link | Role |
| --- | --- |
| [Documentation overview](docs/overview.md) | Orientation summary: what Saivage is, the card model, agent roles, the run loop, and vocabulary. Not an authority. |
| [Getting started](docs/guides/getting-started.md) | Guide: build, initialize, configure, start, and hand over a first objective. |
| [Configuration](docs/guides/configuration.md) | Guide: every `saivage.yaml` key with annotated examples. |
| [Operating a project](docs/guides/operating.md) | Guide: the control room, the Analyst conversation, and long-run operation. |
| [System specification](docs/spec/system-specification.md) | Sole authority for product, runtime, CLI-visible behavior, and exact functional contracts. |
| [Operator UI needs](docs/spec/operator-ui-needs.md) + [contracts](docs/spec/operator-ui-contracts.md) | Authority for operator web UI requirements and exact presentation contracts. |
| [System architecture](docs/architecture/system-architecture.md) | Sole authority for component ownership, dependency direction, internal architecture, and source-derived inventories. |
| [Durable format changes](docs/architecture/durable-format-changes.md) | Source-contract baseline and evidenced cutovers under [AGENTS Storage Policy](AGENTS.md#durable-format-versioning), not exhaustive compatibility certification or operational consent. |
| [Operator runbook](docs/runbook/index.md) | Sole authority for deployment, startup, lifecycle, recovery, reset, and other operator procedures. |
| [Validation internals](docs/validation.md) | Validation toolchain detail: guard contracts, CI job topology, and browser/E2E profiles. |
| [README](README.md) | Introduction, minimal quick start, authority navigation, and repository validation profiles. |
| [AI setup procedure](README-IF-YOU-ARE-AN-AI.md) | Subordinate seven-stage LXC setup procedure; follow its links to the authorities above. |

For prompt customization, see the canonical [shipped project-guidance authoring guide](docs/architecture/prompts.md#authoring-shipped-project-guidance).

## Notable current behaviors

- Codex uses stable owner-session cache affinity; reuse remains provider-dependent,
  with no guaranteed hits or savings. This source-only change requires no reset;
  other format cutovers still apply. Live efficacy needs separately authorized
  [bounded commissioning](docs/runbook/index.md#codex-cache-affinity-and-bounded-commissioning),
  not just source tests.

- Latest provider-exchange metadata retains provider-reported input/output/total,
  cached-input and reasoning-output tokens when reported; unknown is not zero and
  subsets are not additional totals. This is not billing or complete accounting.
  See [semantics](docs/spec/system-specification.md#provider-reported-token-usage) and
  the separately authorized [incompatible payload adoption](docs/runbook/index.md#provider-usage-payload-adoption).

- Strict startup errors require stop/disable restarts, positive no-owner verification,
  a successful complete fresh preserved backup, then one exact offline report/consent
  repair and separate restart. For example, from the project root:
  `saivage repair --target card:card-a --backup /absolute/backup --report /absolute/fresh-report.md`.
  Record and conversation targets use `record:ID/NAME` and `conversation:SESSION_ID`.
  Absolute backup/report paths must be outside Saivage generated/lifecycle roots;
  ordinary project source-side paths are allowed. Report must be fresh and outside
  the declared backup as well.
  Only both unusable card selections permit separately confirmed `--discard-card`;
  non-root discard requires configured parent-permitted `--card-type`, project type
  is fixed. Own data and former descendant reachability can be lost; FAILED is not
  an operator-only hold (later ancestor Run may Planner-reopen unchanged placeholders).
  No scans, reconstruction, automatic repair/restart or deployment authorization.
  See the [full procedure and limits](docs/runbook/index.md#exact-target-offline-repair).

- Card/record publications now require fresh `head_id` UUIDs alongside current
  revision, and every card/record head and conversation index maintains one
  previous hardlink slot. Normal reads/startup never use it as fallback; the
  sequence is nontransactional and does not guarantee a usable prior selection.
  The required identity field is a separate **incompatible format adoption**, even
  with unchanged outer format 1 at its pre-policy introduction, not permission for
  future version reuse. Exact-target offline repair is available; see the
  [runbook](docs/runbook/index.md#previous-selectors-and-head-identity-adoption).

- Cards use small current heads selecting immutable ordinary history and current-only mailbox UUID pointers; records select accepted predecessor history and current drafts. Queue-only revisions and draft-only record revisions are not historical selectors. Current freshness counts every mutation, catalogs count retained entries, and accepted provenance separates observed current card revision from its ordinary history link. Delivery appends conversation bodies before removing pointers and can repeat after interruption. Forgotten physical files remain ignored forever; this is not physical erasure, a queue audit, or solved check-once/startup certification. [Incompatible adoption](docs/runbook/index.md#external-migrations) chooses separately consented destructive reset or explicitly owner-requested external offline migration. No core compatibility/migration code, automatic conversion or implicit deployment/loss consent.

- Provider-exchange evidence now belongs to each exact conversation session rather
  than the app log; adopting this layout from an existing three-lane app log is a
  **incompatible cutover**, not a same-format upgrade. Source
  completion is not deployment or loss authorization. See the
  [reset-versus-external-migration decision](docs/runbook/index.md#external-migrations).
- Conversation compaction is model-aware (`context_utilization_fraction` 0.80,
  `trigger_fraction` 0.90, `tail_fraction` 0.25) with one contextual
  sequential-refine accumulator inside a shared 16-logical-call bound. A narrowly
  identified internal-summary policy flag gets one immediate identical retry;
  persistent flagging blocks the owning card safely instead of continuing or
  exposing provider prose. See the
  [compaction runbook](docs/runbook/index.md#prepared-conversation-compaction).
  Conversation index/genesis/segment format **6** retains summary, protected
  instructions, required model facts, and continuation without compaction
  checksums or accumulated accounting. Adoption from earlier formats is a
  **incompatible cutover** across all four generated roots: separately consented
  reset loses history; explicitly requested external migration reports evidenced
  fidelity and confirms any unavoidable concrete loss. Both require stopped exclusion
  and a successful complete preserved backup; source completion authorizes no instance
  action or binary-only rollback. See the
  [storage and cutover rules](docs/runbook/index.md#storage-and-interruption)
  ([prompt contract](docs/architecture/prompts.md),
  [cutover procedure](docs/runbook/index.md#configuration-file-cutovers)).
  Responses private rows additionally require successful-producer provenance;
  same local provider/account identity retains encrypted reasoning, other
  identities omit only encrypted reasoning before request admission. Adopting
  this payload also requires the separate incompatible-adoption decision, even
  with matching outer versions; those alone are not compatibility.
  Card/record format-1 heads and immutable predecessor documents are a separate
  incompatible adoption boundary; this source change authorizes no deployment,
  external migration or destructive reset.
- New projects enable an independent two-hour
  [Project Oversight](docs/spec/system-specification.md#project-oversight)
  check by default; its only project effect is an evidenced notification.
- The three remaining growing JSONL families (conversation, app log, provider evidence) use exact owner-at-use reads that may discard
  only a torn final suffix after full retained-prefix validation. Complete
  corruption remains strict, older conversation segments remain immutable,
  and uncertain truncation is fatal. See the
  [interruption contract](docs/runbook/index.md#storage-and-interruption).
- Process tools return bounded, redacted inline stdout/stderr heads with
  completeness flags and durable log URLs
  ([process result contract](docs/spec/system-specification.md#7-run-pause-resume-stop-and-restart));
   adopting that payload from metadata-only rows is an incompatible cutover
  ([procedure](docs/runbook/index.md#card-process-configuration-and-prompt-cutover)).
- `glob`/`grep` results are packed into byte-bounded stateless pages
  ([search result contract](docs/spec/system-specification.md#10-prepared-invocation-exact-admission-and-compaction)).

## Verification

Use the profile that matches the change; `docs/validation.md` owns the
toolchain internals and CI topology behind them.

Build (and release through build) checks compiler-derived classic/classic-typed
shared-template parity during prompt packaging, then runs compiled prompt
composition with source/package byte comparison and all five selected roles.
Routine validation does not run these build checks.

| Profile | Runs | Use for |
| --- | --- | --- |
| `npm run validate:docs` | `docs:verify` (docs build + all drift guards); excludes `npm test` and `web:test:operator-smoke` | Documentation-only changes |
| `npm run validate:routine` | typecheck, `check:export-consumers`, canonical-persistence drift, architecture Jest, `docs:verify` | Routine backend/runtime changes (not complete backend Jest or lint) |
| `npm run validate:ui-smoke` | `npm run web:test:operator-smoke` | Quick UI/operator smoke |
| `npm run validate:ui` | web typecheck, complete `web:test`, operator browser smoke | Web UI changes |
| `npm run validate:release` | typecheck, build, non-E2E Jest, backend E2E, operator smoke, docs | Release sign-off |

Focused backend commands: `npm test` is the
complete non-E2E backend authority — it runs ordinary parallel Jest 30 (ts-jest ESM) followed by the exact serial
real-terminal-child suite after ordinary workers exit. Use `npm run
test:parallel -- <Jest arguments>` or `npm run test:direct -- <Jest
arguments>` for focused tests in the ordinary Jest set, which excludes the
terminal-child suite; run `npm run test:terminal-child` for that in-band
exceptional suite, and `npm run test:e2e` for the backend E2E tier.
Jest owns explicit JS/TS test families; the import-boundary `.cjs` regression
suite remains owned by `node --test` through `npm run test:import-boundaries`.
Release-profile success does not replace the separately required
`npm run audit:security` high/critical gate for both root and web graphs.
Export or backend boundary refactors require the focused semantic export test
(`npm run test:direct -- --runInBand --runTestsByPath tests/scripts/export-consumers.test.js`),
`npm run check:export-consumers`, `npm run test:import-boundaries`, and the full
`npm test` parallel-plus-serial run. `validate:routine` runs only architecture Jest
and is not sufficient validation for these refactors. Shared-root export changes
also require `node scripts/check-web-browser-imports.cjs`,
`npm --prefix web run build`, and focused root-consuming browser tests; Node
typecheck and Jest alone do not establish browser eligibility.
Required guards: `npm run check:export-consumers`, `npm run
web:test:operator-smoke`, `npm run lint`, `npm run test:import-boundaries`,
`npm run audit:security`, and `npm run deps:review`. Root and web
dependencies must be installed before `npm run check:export-consumers`,
`npm run lint`, or `npm run validate:routine`.

For development-tool refreshes, run `node --test
tests/scripts/devtool-security.test.cjs`, the focused Vitest lifecycle regression,
and the existing browser-client smoke. See the [development-tool semantic
checks](docs/validation.md#development-tool-semantic-checks) for commands and
evidence limits; these supplement, not replace, the build/UI/browser and audit
profiles.

`npm run lint` currently runs the export-consumer guard, stamp-producer guard, ESLint,
backend import-boundary checks, web-component boundary check, reachable-browser
import guard (`node scripts/check-web-browser-imports.cjs`), then the
`npm run format` Prettier check. This sequence describes the current script;
the cadence guard requires coverage and fail-propagating composition, not the
relative order of independent checks. The formatter checks `src/` excluding
`src/config/system-templates/**/prompts/**` with the existing Prettier settings
and does not rewrite files. Shipped model-facing prompt bytes, including whitespace,
are edited deliberately; packaging parity, source/package byte comparison, and
compiled composition checks remain in build. The existing CI `lint-guards` job enforces this
profile through `validation-required` under its applies/skipped semantics;
`validate:routine` runs architecture Jest, not lint or the complete backend suite.

CI notes: the always-run `routine-docs` job clean-installs both root and web
dependencies before running `validate:routine` once, including its sole
`docs:verify` gate; it does not separately run `validate:docs`.
`backend-jest-build` also clean-installs root (`npm ci`) and web (`cd web && npm ci`)
dependencies before build and non-E2E Jest. Required coverage and real setup
prerequisites are enforced, not incidental ordering of independent operations.
`npm run web:test:e2e:smoke` is the
complete self-contained browser profile: it owns
every production-preview smoke test
and the one source browser-client test. The preview owner starts the
production preview server; the browser-client owner starts the Vite
dev server, and neither contacts a live Saivage deployment. After a failed or cancelled
CI browser run, a best-effort artifact upload preserves
`tmp/playwright-report` and `tmp/playwright-results`; missing output only
warns. See [validation internals](docs/validation.md) for the guard
contracts, full CI topology, and dependency governance.

```bash
npm run check:export-consumers
npm run validate:docs
npm run validate:routine
npm run validate:ui-smoke
npm run validate:ui
npm run validate:release
npm run audit:security
npm run deps:review
```

README owns validation selection and navigation, not product contracts.
