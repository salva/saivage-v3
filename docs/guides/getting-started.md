# Your first project

This tutorial takes a **fresh, disposable target** from initialization to an
explicit first Run, shows how to understand its work and outcome, then ends the
trial. Read the [overview](../overview.md) if
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

In the Saivage source checkout available to the isolated guest (not the target):

```bash
npm ci
(cd web && npm ci)
npm run build
```

The build includes server, web UI, documentation and build smoke checks. A missing
dependency or unsupported engine is a build problem, not a reason to reset a target.
Keep the built checkout separate from the project it will work on.

## 2. Initialize the disposable target

In the **guest target shell**, substitute absolute guest paths for this trial.
`init` uses the exact current directory and its canonical YAML, not Start's
environment selectors:

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

<a id="start-and-check-readiness"></a>

## 4. Start, then check readiness

First choose the browser access path in [deployment access](../runbook/deployment.md#browser-access-across-namespaces).
A browser in the guest's network namespace can use guest loopback directly. A
browser on the operator host needs an authorized confined forward to that listener;
host loopback is not guest loopback, and the guest IP cannot reach a loopback-only
bind. Establish that prerequisite before continuing, not a wildcard-bind fallback.

In the same **guest target shell**, with its provider environment supplied privately:

```bash
env -u SAIVAGE_API_TOKEN "$SAIVAGE_BIN" start \
  --project-root "$TARGET_PROJECT" --config "$TARGET_PROJECT/.saivage/saivage.yaml" \
  --host 127.0.0.1 --port 8080
```

This foreground command deliberately disables operator bearer authentication for
the isolated browser trial. **Unset**, not blank, selects disabled auth. For a real
installation follow [authentication and public docs](../runbook/deployment.md#authentication-and-public-docs).
Both absolute selectors are intentional: cwd alone does not override inherited
`SAIVAGE_PROJECT_ROOT` or `SAIVAGE_CONFIG`. Keep the terminal open; in a second
**guest shell** check:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/health/ready
```

Expect successful health/readiness responses and a stopped project, not a Run.
An interrupted existing project's successful startup first settles its linked
running chain to stopped; it does not automatically continue it. If startup fails,
read its terminal output: the UI cannot diagnose a server that never became ready.

## 5. Inspect before starting work

On the **operator browser machine**, open the URL for the selected access path:
`http://127.0.0.1:18080/` for the deployment guide's host forward, or
`http://127.0.0.1:8080/` only for a browser in the guest namespace. Select the
project in Cockpit and confirm its identity, root objective and stopped/no-current-work
state. The [operating tour](operating.md) shows the facets. Public docs are at
`/docs/` on that same browser origin.

The browser has no sign-in or token-entry screen. For a deliberately bearer-enabled
installation, complete [private browser credential setup](../runbook/deployment.md#browser-credential-setup)
before protected observations; never put a token in its URL. Unexpected unauthorized
views in this disabled-auth trial belong in the
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
result. Once admitted, the configured workflow owns progression—you do not need to
dispatch each child or approve each transition. Planning may create/activate
children, but the tree need not grow every turn. Replies may take seconds to
minutes; meaningful work may take much longer.

<a id="understand-one-result"></a>

## 7. Follow autonomous work and understand one result

Start with the root **Overview** and its accepted brief. The Planner coordinates
work through children; Executors perform their scoped engineering; configured
review assesses evidence and can return findings for correction. The root's
completion assessment considers remaining authorized work, not just a finished
child. The [overview](../overview.md#execution-and-review) explains that loop; the
[work tour](operating.md) locates its observations. This is not a prescribed tree
or a promise that your trial will finish within a particular time.

When a result is available, select one relevant card and:

1. Compare its **Overview** objective and recorded result with the accepted brief
   in **Records & History**. Open the accepted status, not just a newer draft.
2. Follow the cited work products and checks. For an illustrative small text-parser
   fix, that could mean the changed parser, a regression test for empty input and
   the actual test result. This is an example of evidence to look for, not a claim
   that this tutorial produced those artifacts.
3. If review is configured, read the applicable accepted review and its unresolved
   findings. A leaf need not have its own Reviewer; parent assessment and review
   are separate from that leaf's implementation result. Use **Conversations** or
   **Executions** only when you need the exact agent or action evidence.
4. Return to the root result/status to distinguish local delivery from fulfillment
   of the whole objective. The Planner may continue or replan without your input.

Interpret what you actually find:

| Observation | Meaning for the trial |
| --- | --- |
| Work is ongoing | You can leave it progressing within its authority; lack of a new message alone does not show it is stuck |
| A child is DONE | Its configured workflow accepted that task, not necessarily the whole project |
| The root is DONE | Assess the delivered products and supporting evidence against your criteria; it is not independent correctness, deployment or publication certification |
| Work is BLOCKED | Read the named missing input/decision; supply it through the Analyst if appropriate, rather than adding a new approval gate to ordinary work |
| Work is FAILED or evidence is missing | Keep the failure or uncertainty explicit; do not infer success or replay an old command from an incomplete result |

No result yet is a valid observation. You need not keep the trial running to
manufacture a completion. For a real blocker or changed objective, use
[supported intervention](operating.md#supply-context-and-steer-while-running);
for evidence interpretation, use the [evidence runbook](../runbook/evidence.md).

## 8. End the trial

You can end the trial regardless of whether work completed, failed or is still
ongoing; stopping is not an acceptance verdict.

Ask the Analyst to stop project work, or from the exact target directory use:

```bash
"$SAIVAGE_BIN" stop
```

Project Stop clears live project owners but can leave durable cards `running`;
that retained value is not evidence of continued execution. Project Stop is
containment, **not application shutdown**. It leaves the server,
Analyst, outbound integrations and any external Analyst listener alive. For this
foreground trial, Ctrl+C requests application shutdown. For a managed deployment,
stop its exact service. Close the host forward when finished. Verify actual process/service termination; do not infer
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

Next: [follow work and outcomes](operating.md), [configure capabilities](configuration.md),
or [develop Saivage](development.md). This tutorial is not proof of a qualified
deployment or a successful provider-backed delivery.
