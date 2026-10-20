# Your first project

This tutorial takes a **fresh, disposable target** from initialization to an
explicit first Run, then ends the trial. Read the [overview](../overview.md) if
cards and workflows are new to you. For an existing installation, begin at the
[runbook decision map](../runbook/index.md), not by reinitializing it.

## Before you begin

You need:

- Node.js `>=24 <25` and npm `>=10 <12`, plus the Saivage source checkout.
- An externally isolated environment, normally an LXC container, with a disposable
  target directory. Deployment supplies isolation; Saivage does not create or verify it.
- An authorized provider/model endpoint, credentials and truthful tool/image/context
  capabilities. You will configure both primary routes and a fixed summarizer.
- Permission to write the target, incur model costs and run commands there. Agents
  can modify files and Git, including commits/pushes where access and instructions
  permit. There is no guaranteed automatic commit schedule or approval switch.

::: warning A trial is still consequential
`init` writes configuration and initial durable state. Later Analyst submissions
can invoke providers and tools; Run enables autonomous project work. A disposable
copy protects the original tree, not the host. Loopback binding is not a sandbox
or a defense against untrusted local/browser origins. The auth-disabled browser
trial below is only for a deliberately isolated environment, not general networking.
:::

The commands and prompts are a walkthrough, not authorization to execute them.
Provider-backed and deployment steps require your actual permission and setup.
For an assistant-led LXC installation, use the staged
[AI setup guide](https://github.com/salva/saivage-v3/blob/master/README-IF-YOU-ARE-AN-AI.md).

## 1. Build the application

In the Saivage source checkout:

```bash
npm ci
(cd web && npm ci)
npm run build
```

The build includes server, web UI, documentation and build smoke checks. A missing
dependency or unsupported engine is a build problem, not a reason to reset a target.
Keep the built checkout separate from the project it will work on.

## 2. Initialize the disposable target

Substitute absolute paths for this trial:

```bash
SAIVAGE_BIN="/absolute/path/to/saivage-v3/bin/saivage.js"
TARGET_PROJECT="/absolute/path/to/disposable-target"
mkdir -p "$TARGET_PROJECT"
cd "$TARGET_PROJECT"
"$SAIVAGE_BIN" init
```

Expect separate reports for project layout initialization and configuration
materialization. Fresh init creates `.saivage/saivage.yaml`, materialized prompts
under `.saivage/config/prompts/`, project identity, the root card and required
configured sessions. No project work starts.

Default profile is `classic`. Choose `init --profile classic-typed` or
`init --profile paad-typed` instead **before configuration exists** if desired;
see [profile differences](configuration.md#choose-a-fresh-profile). Existing YAML
and prompt destinations are preserved, not upgraded by another init. Unexpected
existing state belongs in [startup diagnosis](../runbook/diagnosis.md#startup-does-not-reach-readiness).

## 3. Bind models and credentials

Edit the target's `.saivage/saivage.yaml` using the
[coherent provider/routes/summary example](configuration.md#wire-provider-routes-and-summary).
It replaces those three top-level sections while retaining the freshly generated
agent catalog, Oversight and card types. Replace illustrative endpoint/model limits
with facts for your selected service; it is not a universal provider preset.

Ensure all five generated routes resolve: Analyst, Oversight, Planner, Reviewer
and Executor. Choose a summarizer candidate explicitly. Bundled image-enabled
agents need compatible image routes and summary capability; Chat transport does
not implement image input. A text-only setup must deliberately remove `view_image`
from the relevant exact tool lists instead of silently relying on a fallback.

Supply the credential through the trial process/service environment, without
printing it or committing it. `${TRIAL_PROVIDER_API_KEY}` in YAML reads that
environment variable at load. Missing variables substitute empty text and produce
advisory warnings on a successful load; that warning neither validates a key nor
bypasses strict schema/compiler checks.

Startup does not probe remote credentials. The first authorized model call can
still fail. There is no built-in documented monetary cap: `max_tokens` and
compaction are not spending limits. Use provider-side controls if available and
monitor actual charges. Analyst calls can continue to cost money after project Stop.

## 4. Start, then check readiness

From the target directory, with its provider environment supplied privately:

```bash
env -u SAIVAGE_API_TOKEN "$SAIVAGE_BIN" start --host 127.0.0.1 --port 8080
```

This foreground command deliberately disables operator bearer authentication for
the isolated browser trial. **Unset**, not blank, selects disabled auth. For a real
installation follow [authentication and public docs](../runbook/deployment.md#authentication-and-public-docs).
Keep the terminal open; in another terminal check:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/health/ready
```

Expect successful health/readiness responses and a stopped project, not a Run.
An interrupted existing project's successful startup first settles its linked
running chain to stopped; it does not automatically continue it. If startup fails,
read its terminal output: the UI cannot diagnose a server that never became ready.

## 5. Inspect before starting work

Open `http://127.0.0.1:8080/` and select the project in Cockpit. Confirm its identity,
root objective and stopped/no-current-work state. The [operating tour](operating.md)
shows the facets. Built public documentation is at `http://127.0.0.1:8080/docs/`.

The browser has no sign-in or token-entry screen. A bearer-enabled instance shows
unauthorized views; do not put a token in its URL. Diagnose it using the
[unauthorized procedure](../runbook/diagnosis.md#unauthorized-ui-or-api).

## 6. Supply an objective, then explicitly Run

Create a small nonsecret specification in the disposable target, or give the
Analyst a bounded objective. First ask for setup **without starting**:

> Read SPEC.md, summarize the objective and acceptance criteria, and prepare the
> root brief. Do not start project execution yet. Tell me what you changed.

This is a provider/tool interaction requiring permission, not a read-only UI action.
Inspect the accepted root brief in **Records & History** and correct scope through
the Analyst if necessary. Then request execution separately:

> Start this project now using the accepted root brief.

The Analyst can call `start_project`; a prose promise alone is not evidence that
Run was admitted. Inspect runtime state, current work and the corresponding tool
result. Follow the selected card's **Conversations**, **Executions** and records.
Planning may create/activate children, but the tree need not grow every turn.
Replies may take seconds to minutes; meaningful work may take much longer.

## 7. End the trial

Ask the Analyst to stop project work, or from the exact target directory use:

```bash
"$SAIVAGE_BIN" stop
```

Project Stop is containment, **not application shutdown**. It leaves the server,
Analyst, outbound integrations and any external Analyst listener alive. For this
foreground trial, Ctrl+C requests application shutdown. For a managed deployment,
stop its exact service. Verify actual process/service termination; do not infer
all children were contained merely from a Stop acknowledgment. See
[project Stop and application close](../runbook/runtime-control.md#project-stop-and-application-close).

If keeping the trial, use a [complete stopped backup](../runbook/deployment.md#offline-exclusion-and-complete-backups).
Treat it as sensitive. Do not delete generated files to make later startup pass;
repair, reset and migration have separate procedures and consent.

## If a step fails

| Symptom | Next step |
| --- | --- |
| Build/engine error | Check supported Node/npm, install root **and** web dependencies, rebuild |
| YAML/tool/model binding error | Correct the reported selected input; [configuration lookup](../reference/configuration.md) |
| No readiness, existing state or lock error | [Startup diagnosis](../runbook/diagnosis.md#startup-does-not-reach-readiness); do not repeatedly restart or remove a lock |
| First provider call fails | System → Errors and Provider availability; [provider diagnosis](../runbook/diagnosis.md#provider-unavailable-or-overloaded) |
| No apparent progress | Inspect exact current card/session and action evidence; ask for an observation, not guessed success |
| Data-format failure | [Choose adoption versus repair](../runbook/state-adoption.md#choose-the-operation), not another init |

Next: [operate and steer](operating.md), [configure capabilities](configuration.md),
or [develop Saivage](development.md). This tutorial is not proof of a qualified
deployment or a successful provider-backed delivery.
