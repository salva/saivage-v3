# Getting started

Strict startup does not automatically restore previous selections or reconstruct
history. On same-format corruption, stop/disable restarts, verify no owner, preserve
a successful complete fresh backup, and follow [exact-target offline repair](../runbook/index.md#exact-target-offline-repair)
with external report/typed consent and separate restart. No unattended repair or
availability guarantee; incompatible adoption separately chooses consented reset or
explicitly owner-requested [external migration](../runbook/index.md#external-migrations).
Catastrophic card discard requires both unusable selections and extra
destructive consent (explicit configured type for non-root), loses own state and
unlinks children without moving them. Later ancestor Run may Planner-reopen the
synthetic FAILED replacement and execute unchanged placeholder requirements.

Status: non-authoritative guide. Contracts and exact behavior are owned by the
[System specification](../spec/system-specification.md), the
[Operator UI needs](../spec/operator-ui-needs.md) and [contracts](../spec/operator-ui-contracts.md), and the
[Operator runbook](../runbook/index.md).

This guide takes you from nothing to a running Saivage instance working on
your first objective. If you are new to Saivage, read [What is
Saivage](../overview.md) first. Configuration details live in the
[Configuration guide](./configuration.md); day-to-day use lives in
[Operating a project](./operating.md). For unfamiliar terms such as card and
brief, see the [glossary](../overview.md#glossary).

## What you need first

- **Node.js 24** (`node >=24 <25`, `npm >=10 <12`).
- **A target project directory** — the codebase or workspace Saivage will work
  on. It can be empty (Saivage can create the project from a specification)
  or an existing repository.
- **A provider** — choose a model and matching endpoint, credentials, and
  capabilities. Examples of the *endpoint category* are OpenAI Chat Completions,
  OpenRouter, or a local vLLM-compatible endpoint; none guarantees that every
  model on that service supports Saivage's tool use. Check the selected model's
  native tools and exclusive tool-choice behavior before copying the
  [provider configuration](./configuration.md#providers).
- **An isolated environment** — Saivage is designed to run inside an
  externally isolated container in which its agents are trusted and may use
  root. The deployment, not Saivage, provides that isolation. Read the
  [trust model](../architecture/system-architecture.md#deployment-and-trust-model)
  before exposing any instance to a network. For a first agent-run trial, use
  a disposable target (such as a controlled copy) inside a trusted, externally
  isolated VM/container; copying protects the original tree, not the host.
  Loopback binding does not sandbox agents or protect against untrusted local/browser
  origins. The trial below deliberately disables operator authentication; use
  the [runbook](../runbook/index.md) for real deployment decisions.

::: warning Before initializing a target or giving the first objective
The configured agents can run commands and modify the target project (including
its files and Git repository). `init` also writes Saivage configuration and the
root card into that target. Begin with disposable work in an externally isolated
environment, not a valuable live repository. A disposable copy limits damage
to the original tree; it does not contain commands running on the host. The
loopback, auth-disabled example below is a deliberately isolated trial, **not**
a safe deployment recipe or an agent sandbox.
:::

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
a durable project identity, and the root project card. Use `init --profile
classic-typed` **before any config exists** if you want the typed card-type
workflows instead of the classic set (see
[Configuration](./configuration.md#card-types)).

## 3. Configure a provider

Edit `.saivage/saivage.yaml`. At minimum, point the model routes at your
provider and set the compaction summarizer to a model with a large context
window. With the default classic template, replace its five placeholder
routes and add your provider. This single-provider example assumes a selected
Chat Completions model that actually supports native tools and native exclusive
tool choice; substitute your service's real URL, model ID, environment key,
capabilities, and limits. Do not copy those capabilities or token numbers for
an unverified endpoint:

```yaml
providers:
  my-provider:
    apiKey: ${MY_PROVIDER_API_KEY}
    baseUrl: https://api.example.com/v1
    capabilities:
      transportProtocol: openai-chat-completions
      toolsMode: native
      exclusiveToolChoiceSupport: native
      contextWindowTokens: 400000 # illustrative; use the model's actual limit
      maxOutputTokens: 65536     # illustrative; cover route requests and 2000-token summaries
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

Model calls can incur provider charges: the configured Analyst, Oversight,
Planner, Reviewer, and Executor use their routes **when invoked**, not all on
every turn. Oversight checks periodically while eligible; the separate
compaction summarizer is called only when summarization is needed. Stopping
project execution does not disable the Analyst. Total cost depends on selected
models, context and output sizes, repeated calls, and provider pricing; this
example promises no price, completion time, or automatic monetary cap.

## 4. Start the server

```bash
env -u SAIVAGE_API_TOKEN "$SAIVAGE_BIN" start --host 127.0.0.1 --port 8080
```

Unset is the only selector for disabled authentication; a blank or
whitespace-padded token fails startup. This command unsets the variable for
this trial process only, not a deployment's credentials. Check the public
probes:

On an existing interrupted project, successful server startup settles the
linked running cards to stopped; these probes are available only afterward.
Startup does not Run the project: ask the Analyst to start work explicitly.

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

**Separate bearer-enabled API deployment example (not a UI bootstrap step):**
send a token only in the `Authorization` header, never in a URL. The browser
control room has no token-entry screen; in bearer mode it shows unauthorized
views rather than offering sign-in. See the
[runbook](../runbook/index.md#operator-rest-authentication) for operator API
authentication.

```bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/processes
```

## 5. Open the control room

For the auth-disabled trial, browse to `http://localhost:8080/`; no token entry
is needed or available. The [operating guide](./operating.md) tours the control
room with five screenshots captured from a disposable local fixture. The built
documentation is served at `http://localhost:8080/docs/`.

::: tip First-run troubleshooting: symptom → next action
- **Build or engine error** → Check `node --version` and `npm --version` against
  the supported ranges above. Select supported versions, install both the root
  and `web/` dependency trees, then rebuild.
- **Startup YAML or binding error** → Read the reported field or path in the
  terminal/service output and correct the selected configuration. Not every
  startup failure names a YAML key; follow the runbook's
  [stopped-change guidance](../runbook/index.md#configuration-file-cutovers)
  before changing an existing deployment. If startup has not succeeded, the
  control room's System page is not available for diagnosis.
- **First provider call fails after startup** → Check **System → Errors** and
  **System → Provider availability**; review the selected provider, model,
  capabilities, and service environment without exposing credentials. Startup
  checks configuration shape and binding, not remote credential validity.
- **Unauthorized control room** → Check whether you deliberately started in
  bearer mode rather than the auth-disabled trial. The browser has no sign-in
  flow; consult the [operator authentication procedure](../runbook/index.md#operator-rest-authentication)
  for a bearer-enabled API deployment instead of entering a token in the UI.
:::

## 6. Give it your first objective

Use the Analyst conversation on the right of the control room. Describe what
the project must achieve — paste or point to the specification — then ask it
to start:

> This project's objective is described in SPEC.md at the repository root.
> Read it, propose the root brief, and start the project.

The Analyst can edit the root brief with you and then calls `start_project`.
An Analyst reply may take seconds to minutes; meaningful project work can take
hours or longer, depending on the objective and provider. The tree need not
grow continuously. If progress is not visible, check the selected card's
**Conversations** and **Records & History**, then **System → Errors** and
**System → Provider availability** for diagnostics; ask the Analyst what it
can observe. After the explicit start, the runtime plans and executes
autonomously. Use **Cockpit** to follow the card tree and a selected card's
**Conversations**, **Records & History**, and **Evidence**; **Files** shows
the virtual project files, and
**System** shows global participants and runtime diagnostics. The Analyst
panel stays available for steering. Saivage keeps working between your visits
and asks for you only when a real decision is missing — see
[Operating a project](./operating.md).

## Frequently asked questions

### What will it cost; can I cap it?

There is no documented built-in monetary spending cap. Choose your model routes
and token limits deliberately, use provider-side spending controls **if your
provider offers them**, and monitor usage with the provider. Stop project work
when needed; project Stop does not disable Analyst access, so further Analyst
messages can still incur model costs. `max_tokens` and compaction are not dollar
caps. See [configuration](./configuration.md) and the
[runtime-control procedure](../runbook/index.md#runtime-controls-and-lifecycle-lock).

### How do I stop everything?

From the **exact target project** directory, `"$SAIVAGE_BIN" stop` delegates
project Stop: it halts project execution but leaves the server, Analyst, MCP,
and lifecycle lock live. Pause is cooperative, not shutdown. For the foreground
trial, Ctrl+C signals application shutdown; for a managed deployment, stop its
exact service using its service manager/unit. Verify that the process or service
has actually terminated rather than assuming every child was contained by a
Stop acknowledgement or a cleanup report. See the runbook's
[runtime controls](../runbook/index.md#runtime-controls-and-lifecycle-lock) and
[terminal cleanup/failure semantics](../runbook/index.md#terminal-application-cleanup).

### How do I back up?

Stop the actual service or foreground process and verify there is no live owner
of the exact target before copying the **full target project**, including hidden
`.saivage/` configuration and state and the project's source. Separately
preserve any deployment-owned inputs outside the target. Treat the copy as
secret-bearing; do not publish it. Consult the runbook's
[stopped full-backup procedure](../runbook/index.md#agent-and-workflow-identity-cutovers)
and [storage/interruption constraints](../runbook/index.md#storage-and-interruption)
before any reset or cutover. A backup does not authorize restore, selective
merge, history repair, rollback, or reset; it cannot guarantee recovery from
corruption or data loss.

### Will it commit to my repository?

Agents configured with command tools can run Git, including commits and, if
the environment, instructions, and credentials permit it, pushes. Whether
they do so depends on their configured tools and project guidance; there is
no universal “commit only after approval” switch or guaranteed automatic
commit schedule. Use a disposable target and choose credentials and access
deliberately. Prompt guidance is not a security sandbox: see the
[trust model](../architecture/system-architecture.md#deployment-and-trust-model)
and [configured agent tools](../architecture/system-architecture.md#agent-tools).

## Where to go next

- [Configuration](./configuration.md) — every `saivage.yaml` key explained.
- [Operating a project](./operating.md) — the control room, steering, and
  long-run behavior.
- [Operator runbook](../runbook/index.md) — deployment, lifecycle, recovery,
  and reset procedures (authoritative).
