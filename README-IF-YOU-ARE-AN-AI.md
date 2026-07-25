# Setting Up a Saivage Instance as an AI Agent

This guide is for an AI agent helping a person deploy Saivage v3 for a target
software project. It describes a generic LXC deployment and deliberately uses
placeholders rather than assumptions about a particular host, project, network,
provider, or account.

Your job is not merely to collect inputs and disappear into a long setup. Work
in short, visible stages. Before each stage, tell the user what you are about to
do and why. After it, report what was verified, what changed, and what comes
next. Ask only for decisions or access that matter at that point.

## Operating Principles

1. Inspect before changing anything. Confirm the host, repository, target
   project, existing containers, and existing `.saivage` state.
2. Never ask the user to paste passwords, API keys, access tokens, or private
   keys into chat. Arrange a local secret-entry step or use an already approved
   secret source without displaying its value.
3. Never print provider configuration, auth profiles, environment files, or
   secret values in progress reports or command output.
4. Do not overwrite an existing container, LXC configuration, systemd unit,
   target `.saivage` directory, specification, or source checkout without
   explaining the conflict and obtaining approval.
5. Prefer sensible defaults for reversible details. Use the strongest available
   tool-capable model, port `8080`, an Ubuntu 24.04 LXC guest, and a service name
   derived from the container unless the environment requires something else.
6. Ask about choices with real consequences: deployment host, target project,
   network exposure, provider/account, project requirements, destructive reset,
   and replacement of existing configuration.
7. Saivage agents inside the externally isolated container are trusted and may
   run root commands. LXC isolation is deployment-owned; Saivage does not create,
   detect, or verify that boundary itself.
8. Keep Saivage state project-local under `<TARGET_PROJECT_HOST_PATH>/.saivage`.
   Do not use `~/.saivage`.
9. Treat `docs-old/` and historical material as provenance. Use `README.md`,
   `docs/spec/system-specification.md`, `docs/spec/operator-ui.md`, and
   `docs/architecture/system-architecture.md` from the current checkout as
   authority.

## What You Need

The deployment consists of:

- A POSIX host with classic LXC installed and a working LXC bridge/network.
- Root-equivalent access to that host, either through passwordless `sudo` or
  SSH as root. Interactive `sudo` is acceptable if the user enters the password
  in their own terminal; do not request the password in chat.
- A Saivage v3 source checkout on the host.
- A target project directory on the host.
- Node.js 24 and npm 10 or 11 on the build host.
- Internet access during installation unless dependencies and a Node.js 24
  runtime are already available locally.
- At least one tool-capable LLM provider and an approved credential mechanism.
- A decision about who may reach the operator UI and API.

Use these names consistently while working:

```text
<DEPLOYMENT_HOST>             host where LXC runs
<CONTAINER_NAME>              unique LXC name
<SAIVAGE_SOURCE_HOST_PATH>    absolute host path to this checkout
<TARGET_PROJECT_HOST_PATH>    absolute host path to the managed project
<SAIVAGE_CONTAINER_PATH>      normally /opt/saivage-v3
<TARGET_CONTAINER_PATH>       normally /work/project
<SERVICE_NAME>                normally saivage.service
<SERVICE_USER>                in-container runtime user, normally saivage
<SERVICE_GROUP>               in-container runtime group, normally saivage
<SERVICE_UID>                 numeric owner UID of the host target directory
<SERVICE_GID>                 numeric owner GID of the host target directory
<CONTAINER_IP>                discovered after startup
<MODEL_ID>                    selected provider model ID
<PROJECT_SPEC_PATH>           existing project authority, or docs/SPEC.md for a new project
```

Do not substitute placeholders until you have verified their values.

## Phase 1: Establish Access and Scope

Start with a short explanation such as:

> I will first verify that I can administer LXC and locate both directories. I
> will not create a container or modify the project during this check.

Ask the user only for missing facts:

1. Which host should run the instance, and should you access it locally with
   `sudo` or remotely with root SSH?
2. What are the absolute host paths of the Saivage checkout and target project?
3. Is this a new deployment, or may a container or `.saivage` state already
   exist?
4. Should the UI be host-only/private-network-only, or intentionally reachable
   from another network?

Derive a clear container name from the target project. Ask for another name only
if it collides. Do not ask the user to choose a Linux distribution, mount paths,
service name, package manager, or port unless your preflight finds a reason the
defaults will not work.

Run read-only checks on the deployment host:

```bash
id
sudo -n true
sudo lxc-ls --fancy
sudo lxc-checkconfig
node --version
npm --version
git -C "<SAIVAGE_SOURCE_HOST_PATH>" status --short
test -d "<TARGET_PROJECT_HOST_PATH>"
```

When using remote root SSH, run the equivalent checks through
`ssh root@<DEPLOYMENT_HOST> '<command>'`. Do not use newer `lxc list` or
`lxc exec` commands on a classic LXC host.

Also inspect, without dumping secrets:

- Whether `<CONTAINER_NAME>` exists.
- Whether the two host paths are real directories.
- Whether the target is a Git repository and whether it has uncommitted work.
- Whether `.saivage`, a specification, a plan, or equivalent project authority
  already exists.
- The target directory owner's numeric UID and GID. Reuse them for the
  in-container service user when practical so bind-mounted files retain useful
  host ownership.

Report the result before continuing. If the host lacks LXC, Node 24, sufficient
access, or a valid target directory, explain the specific prerequisite you need
to fix. Ask before installing host packages or changing host networking.

## Phase 2: Understand the Project and Write Its Specification

Do this before autonomous work begins. A useful Saivage instance needs a clear
objective more than it needs elaborate deployment customization.

Explain that you will inspect existing source and documentation, then help turn
the user's intent into a reviewable specification. Read existing authoritative
files first. Do not replace a current specification merely to impose a template.

Ask project questions in small groups and adapt them to what is already known:

- What problem should the project solve, and for whom?
- What outcomes define success?
- What is explicitly out of scope?
- What technical, product, legal, data, compatibility, or deployment constraints
  are fixed?
- Which commands or observable behaviors will prove acceptance?
- May Saivage make broad architectural changes, add dependencies, and commit its
  work, or are there restrictions?

Do not ask the user about formatting, heading names, file naming, ordinary test
organization, or other low-impact choices. Infer those from the project.

Identify the target repository's canonical requirements path and call it
`<PROJECT_SPEC_PATH>`. Preserve an existing convention. Only default to
`docs/SPEC.md` when the project has no established authority. Draft or improve
that document using at least these concepts:

```markdown
# Project Specification

## Purpose
## Users and Use Cases
## Functional Requirements
## Non-Functional Requirements
## Constraints
## Out of Scope
## Acceptance Criteria
## Open Questions
```

Use testable statements, distinguish requirements from possible implementation,
and record unresolved decisions as open questions rather than inventing answers.
Show the user a concise summary of the draft and ask them to confirm the product
meaning, not every wording detail. If a separate plan would help, preserve the
project's established location or default to `docs/PLAN.md`; create it only after
the specification is accepted and keep it subordinate to the spec.

Commit project documentation only if the target repository's own policy permits
you to do so. Never mix this deployment guide's repository history with the
target project's history.

## Phase 3: Build Saivage on the Host

Tell the user that the source is built on the host and then bind-mounted into the
container. This avoids maintaining a second checkout and makes upgrades explicit.

Verify Node.js 24 and npm versions against `package.json`, then run:

```bash
cd "<SAIVAGE_SOURCE_HOST_PATH>"
npm ci
(cd web && npm ci)
npm run build
```

The build should produce the compiled runtime, web UI, and documentation. If the
checkout already has installed dependencies, still use `npm ci` when preparing a
fresh reproducible deployment unless the user has a concrete reason not to.

Report the build result. Do not continue with a broken build. Do not discard
unrelated source changes if the checkout is dirty.

## Phase 4: Create the LXC Container

Before creating anything, explain the layout:

- Saivage source: host `<SAIVAGE_SOURCE_HOST_PATH>` to container
  `<SAIVAGE_CONTAINER_PATH>`.
- Target project: host `<TARGET_PROJECT_HOST_PATH>` to container
  `<TARGET_CONTAINER_PATH>`.
- Saivage source may be mounted read-only for a normal target-project deployment.
- The target mount must be read-write because agents edit the project and store
  project-local `.saivage` state.

Use a privileged system container as the simple baseline because direct bind
mount ownership remains understandable. If host policy requires an unprivileged
container, stop and agree the UID/GID mapping with the administrator. Do not
solve mapping errors by recursively making the target world-writable.

Create a new Ubuntu 24.04 container only after proving that its name is unused:

```bash
sudo lxc-info -n "<CONTAINER_NAME>"
sudo lxc-create -n "<CONTAINER_NAME>" -t download -- \
  --dist ubuntu --release noble --arch amd64
```

Adjust `--arch` to the host architecture when necessary. A failed `lxc-info`
with "does not exist" is the expected precondition; any existing container is a
conflict to inspect with the user.

Stop the container before editing `/var/lib/lxc/<CONTAINER_NAME>/config`. Add
exactly one entry for each verified bind mount:

```text
# Saivage deployment bind mounts
lxc.mount.entry = <SAIVAGE_SOURCE_HOST_PATH> opt/saivage-v3 none bind,ro,create=dir 0 0
lxc.mount.entry = <TARGET_PROJECT_HOST_PATH> work/project none bind,create=dir 0 0
```

LXC destination paths in this file are relative to the container root and have
no leading slash. If Saivage itself is the target project, or the instance is
explicitly intended to modify Saivage source, use a single read-write target
mount rather than overlapping read-only and read-write mounts.

Do not paste a host path containing spaces or LXC configuration delimiters into
an entry as though it were an ordinary shell argument. Use the host's documented
LXC escaping syntax or, preferably, agree on simple absolute deployment paths.

Start and inspect the container:

```bash
sudo lxc-start -n "<CONTAINER_NAME>"
sudo lxc-info -n "<CONTAINER_NAME>"
sudo lxc-attach -n "<CONTAINER_NAME>" -- mount
sudo lxc-attach -n "<CONTAINER_NAME>" -- test -r "<SAIVAGE_CONTAINER_PATH>/bin/saivage.js"
sudo lxc-attach -n "<CONTAINER_NAME>" -- test -w "<TARGET_CONTAINER_PATH>"
```

Discover the actual IP from `lxc-info`; do not assume or reserve a static IP
unless the user or network policy requires one.

## Phase 5: Provision the Guest

Explain that this stage installs only the runtime and administrative tools in
the container; source and project data remain on host bind mounts.

Install a minimal guest toolset:

```bash
sudo lxc-attach -n "<CONTAINER_NAME>" -- bash -lc '
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git openssh-server sudo
'
```

Install Node.js 24 from an organization-approved source. If no package source is
already approved, download the NodeSource setup script first, inspect its origin
and successful download, then use it to install the 24.x package:

```bash
sudo lxc-attach -n "<CONTAINER_NAME>" -- bash -lc '
  set -euo pipefail
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-24.sh
  bash /tmp/nodesource-24.sh
  apt-get install -y nodejs
  node --version
  npm --version
'
```

Node must satisfy `>=24 <25`; npm must satisfy `>=10 <12`.

Create a service user whose numeric UID/GID matches the target host owner where
possible. Give that user passwordless `sudo` inside the externally isolated
container so trusted Saivage agents can perform privileged guest operations.
Do not alter host ownership merely to force a match.

After checking that the chosen names and numeric IDs are unused in the guest, a
typical creation sequence is:

```bash
groupadd --gid "<SERVICE_GID>" "<SERVICE_GROUP>"
useradd --uid "<SERVICE_UID>" --gid "<SERVICE_GROUP>" \
  --create-home --shell /bin/bash "<SERVICE_USER>"
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "<SERVICE_USER>" \
  > "/etc/sudoers.d/90-<SERVICE_USER>"
chmod 440 "/etc/sudoers.d/90-<SERVICE_USER>"
visudo --check --file "/etc/sudoers.d/90-<SERVICE_USER>"
```

Run these commands as container root. If the UID or GID already belongs to the
correct usable guest identity, reuse it instead of creating a duplicate.

Enable SSH only if it is useful for ongoing operations. Install an approved
public key for the service user and optionally root; never read or copy private
keys. Verify SSH before relying on it, while retaining `lxc-attach` as the host
recovery path.

Report the installed Node version, effective service UID/GID, mount access, and
whether SSH was enabled. Do not include key material.

## Phase 6: Bootstrap Saivage Configuration

Tell the user that `saivage init` creates the complete current workflow
configuration, durable project identity, and initial root card. It does not
supply provider credentials or replace the project specification.

Run it from the target project directory inside the container as the service
user:

```bash
cd "<TARGET_CONTAINER_PATH>"
"<SAIVAGE_CONTAINER_PATH>/bin/saivage.js" init
```

This creates `.saivage/saivage.yaml` when absent and publishes the initial
project card. Do not hand-build the nine workflow definitions: preserve the
complete generated defaults and change only the provider, model-routing,
compaction, server, prompt, skill, or MCP settings the deployment actually
needs for initial deployment. Named agents and workflows may later be customized
deliberately, but only as one complete structurally valid configuration rather
than as partial fragments.

If generated state already exists, stop and classify it before proceeding. Do
not selectively delete `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, or
`.saivage/work`. A reset removes those four roots wholesale and must be performed
only with explicit user approval, after the service is stopped and configuration,
credentials, identity, prompts, skills, instructions, source, and canonical
project documents have been preserved.

## Phase 7: Select a Model and Set Credentials

Ask which provider/account the user is authorized to use. If the answer implies
one obvious best tool-capable model, select it and explain the choice instead of
asking the user to compare model IDs. Prefer quality and reliable native tool use
over price unless the user gives a budget or latency constraint. Use a cheaper
model only when the user requests it or provider limits require it.

Verify the provider's current model ID, context window, output limit, endpoint,
and protocol from authoritative provider information. Do not guess model IDs.
The selected model must support Saivage's tool calls.

For an API-key deployment, keep the secret in a root-owned service environment
file outside the target repository. Create a skeleton without values and ask the
user to enter them locally, for example with `sudoedit`:

```bash
sudo install -d -m 700 /etc/saivage
sudo install -m 600 /dev/null /etc/saivage/saivage.env
sudoedit /etc/saivage/saivage.env
```

```text
# /etc/saivage/saivage.env
SAIVAGE_LLM_API_KEY=<entered locally, never pasted into chat>
SAIVAGE_API_TOKEN=<random operator bearer token>
NODE_ENV=production
```

Generate the operator token locally with a cryptographically secure tool, such
as `openssl rand -hex 32`. Do not print it into conversation or place it in a
URL. If the service is intentionally private and the user explicitly chooses
auth-disabled development mode, omit `SAIVAGE_API_TOKEN` and state the risk.

Reference the environment variable from the generated YAML. A generic
OpenAI-compatible chat endpoint has this shape:

```yaml
providers:
  <provider-id>:
    models: ["<MODEL_ID>"]
    apiKey: "${SAIVAGE_LLM_API_KEY}"
    baseUrl: "<PROVIDER_BASE_URL>"
```

For direct public OpenAI Responses, declare the capability explicitly:

```yaml
providers:
  openai:
    models: ["<MODEL_ID>"]
    apiKey: "${SAIVAGE_LLM_API_KEY}"
    baseUrl: "https://api.openai.com"
    capabilities:
      transportProtocol: openai-responses
      toolsMode: native
      exclusiveToolChoiceSupport: native
      streaming: true
      responsesReasoning:
        effort: medium
```

Include `<MODEL_ID>` in every generated route/profile that should select it.
Independently set `compaction.summarizer_candidate` to one exact configured
`provider`, nullable `account`, and `model` identity. Reusing the primary
provider/account/model is the simple default; use a separate summarizer only
deliberately. Keep compaction enabled. Set `input_budget_tokens` no higher than
the usable model context budget after accounting for output and transport
overhead; the configured Analyst `max_tokens` must fit within the compaction
completion reserve.

OAuth profiles are a separate credential mechanism, not interchangeable with a
public API key. If the user has an existing approved `.saivage/auth-profiles.json`,
ask permission to install or preserve it without displaying it and reference the
chosen profile with `authProfile`. Before installation, verify without reading
its contents that the destination is not tracked or staged by version control
and that repository ignore policy covers it. Preserve Saivage's ordinary
process-umask file policy; do not add a permission-repair subsystem. Do not
fabricate OAuth tokens or manually convert one provider's credential into
another provider contract.

After editing, perform a safe structural check by starting the service in the
next phase. Inspect bounded startup logs for interpolation and configuration
warnings. An unset environment variable is replaced with an empty string and may
not prevent a generic provider configuration from starting, so startup and
health alone do not prove credentials work. Do not replace a missing secret with
an empty or hard-coded value in the repository; require a successful provider
invocation before declaring provider setup valid.

## Phase 8: Install the systemd Service

Explain the service command and show the user the non-secret unit before
installing it. Use absolute paths and the target project as `WorkingDirectory`:

```ini
[Unit]
Description=Saivage autonomous development service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=<SERVICE_USER>
Group=<SERVICE_GROUP>
WorkingDirectory=<TARGET_CONTAINER_PATH>
EnvironmentFile=/etc/saivage/saivage.env
ExecStart=/usr/bin/node <SAIVAGE_CONTAINER_PATH>/bin/saivage.js start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If auth-disabled mode was explicitly selected and no other environment values
are needed, omit `EnvironmentFile` rather than creating a fake empty secret
file. Confirm the actual `node` path with `command -v node`.

Install, enable, and start the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now "<SERVICE_NAME>"
sudo systemctl is-active "<SERVICE_NAME>"
sudo systemctl status "<SERVICE_NAME>" --no-pager
```

When running these inside LXC from the host, use root SSH or
`sudo lxc-attach -n "<CONTAINER_NAME>" -- <command>`.

If startup fails, inspect a bounded journal excerpt without exposing environment
or config contents:

```bash
sudo journalctl -u "<SERVICE_NAME>" -n 120 --no-pager
```

Fix the root cause, explain it, and retry. Do not add fallback configuration or
reset project state to hide a validation error.

## Phase 9: Verify the Deployment

First test from inside the container, then from the intended operator network:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS "http://<CONTAINER_IP>:8080/health"
curl -fsS "http://<CONTAINER_IP>:8080/health/ready"
```

The health endpoints are public. When bearer authentication is enabled, verify
one protected endpoint using an Authorization header from a shell where the
token is already loaded:

```bash
curl -fsS \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN" \
  http://127.0.0.1:8080/api/state
```

Never put the bearer token in a query string or command shown with its literal
value. Also verify that the same endpoint returns `401` without the header when
authentication is expected.

Open the web UI at `http://<CONTAINER_IP>:8080/` from the intended operator
machine. If it should not be generally reachable, enforce that in host/container
networking or a reverse proxy. Binding to `0.0.0.0` is not access control.

Report separately:

- Container state and discovered IP.
- Service active state.
- Local and operator-network health/readiness.
- Whether protected API authentication behaved as intended.
- Selected provider and model names, but no credential/account secrets.
- Target project and Saivage source mount paths.

## Phase 10: Align the Root Card and Start Work

The generated root card contains a generic bootstrap objective. Do not let
autonomous work start from that placeholder when a real specification exists.

Open the Analyst UI and ask the Analyst to:

1. Read the accepted `<PROJECT_SPEC_PATH>` and any authoritative project
   instructions.
2. Summarize the objective, constraints, and acceptance criteria for the user.
3. Update the root project brief so it faithfully points to and represents that
   specification.
4. Identify ambiguities or contradictions before planning work.
5. Propose the first high-level decomposition without starting execution.

Ask the user to approve or correct that interpretation. Once approved, instruct
the Analyst to start the project. This creates a human-visible checkpoint between
deployment success and autonomous mutation.

During the first run, remain available and explain what the UI shows: the root
project, child cards, current runtime state, Analyst conversation, and Debug
errors/events. Confirm that at least one real provider invocation succeeds before
declaring the instance fully operational.

## Phase 11: Hand Over Operations

Give the user a concise, deployment-specific handoff without secrets:

- UI URL and intended access boundary.
- Container and systemd service names.
- Host source and target paths and their container mount points.
- How to check health and service logs.
- How to rebuild Saivage after source updates.
- How to restart the service after a successful build.
- Where the project specification and Saivage configuration live.
- Which provider/model is selected and where credentials are managed.
- Any unresolved warnings, open specification questions, or deferred hardening.

Typical maintenance commands are:

```bash
# Build updated source on the host
cd "<SAIVAGE_SOURCE_HOST_PATH>"
npm ci
(cd web && npm ci)
npm run build

# Restart only the Saivage service in the container
ssh root@<CONTAINER_IP> \
  'systemctl restart <SERVICE_NAME> && systemctl is-active <SERVICE_NAME>'

# Verify from the host
curl -fsS "http://<CONTAINER_IP>:8080/health"
curl -fsS "http://<CONTAINER_IP>:8080/health/ready"
```

Saivage CLI `stop` stops the project runtime; it does not terminate the server or
container. Use systemd for service restart/termination and classic LXC commands
for container lifecycle. Before any reset, upgrade, or abandoned-lock repair,
consult the current operator runbook and preserve project configuration,
credentials, identity, prompts, skills, instructions, source, and canonical
documentation.

## Completion Checklist

Do not call the setup complete until every applicable item is true:

- [ ] Root-equivalent host access was verified without disclosing credentials.
- [ ] Existing container, project, and `.saivage` state were inspected safely.
- [ ] The user accepted a testable project specification.
- [ ] Saivage built successfully with Node.js 24 and the supported npm range.
- [ ] The LXC container has the intended isolation and bind mounts.
- [ ] The target mount is writable and source mount policy is intentional.
- [ ] The guest has Node.js 24 and a correctly mapped service user.
- [ ] `saivage init` produced the current complete configuration and root state.
- [ ] Model routing, compaction, and provider capabilities match the selected
  tool-capable model.
- [ ] Secrets are outside version control and were never exposed in chat/logs.
- [ ] The systemd service is enabled and active.
- [ ] Health, readiness, network reachability, and authentication were verified.
- [ ] The Analyst aligned the root brief with the accepted specification.
- [ ] The user explicitly approved starting autonomous work.
- [ ] A real provider call succeeded.
- [ ] The user received a non-secret operational handoff.

If any item is blocked, state exactly what is complete, what remains, why it is
blocked, and the smallest user action needed to continue.
