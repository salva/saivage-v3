# Deploy and start Saivage

Optional deployment-owned source observation has a separate
[observed collections prepare/adopt procedure](./observed-collections.md).
It pins the native binary/model and starts automatic root watchers without manual
index creation. This does not follow implicitly from server deployment.

This is a procedure for an **authorized, identified deployment**, not permission to
operate any remembered container/IP. Newcomers should follow the
[fresh-project tutorial](../guides/getting-started.md). Retained-state changes go
through [state adoption](./state-adoption.md) before starting a different contract.

## Identify the deployment boundary

Record the target project root, service/container, service user, selected release
and entrypoint, Node executable, selected YAML, network bind/auth mode and writable
mounts. Distinguish the Saivage source/release from the target it may modify. Verify
the actual unit/process command and mounts; service names/IPs in historical notes
are not current authority. Never share a project between old/new running binaries.

Saivage expects externally isolated deployment, normally an LXC guest. It neither
creates nor verifies that isolation. In-container agents are trusted and may run as
root; tool constraints do not contain a rogue root-capable agent. Preserve external
authentication and outbound confidentiality regardless of that trust. Do not expose
an auth-disabled listener on general networking. A local browser trial needs
deployment-owned network confinement, not merely a reassuring hostname.

## Build and install

Use the selected coherent source and supported Node `>=24 <25`, npm `>=10 <12`;
prefer the latest supported Node 24 LTS patch. Install backend and web dependencies
with their lockfiles, then build the full release:

```bash
npm ci
npm --prefix web ci
npm run build
```

These commands are for the release checkout, not the managed target. See
[validation](../validation.md) for profile selection. Preserve runtime dependencies,
packaged prompt closures, web assets and built docs beside compiled ESM. Deploy a
positively identified release, not an implicitly changing development tree.
Validation does not authorize deployment or provider spending.

### Native image dependencies

Sharp is a backend runtime dependency, including its native optional packages.
Do not install with `--omit=optional`. Sharp requires Node-API v9/Node >=20.9;
Linux x64 prebuilds require glibc >=2.28 or musl >=1.2.5 and SSE4.2. npm
multi-platform lockfiles have native optional-package caveats: validate a clean
install/import and PNG/JPEG conversion on the intended platform. There is no
ImageMagick, Python, browser or alternate-platform decode fallback. These facts
do not authorize changes to an installed deployment.

## Initialize only a fresh target

From the intended target root, `saivage init` defaults to classic. Optional
`--profile classic-typed` or `--profile paad-typed` selects the complete fresh
template. Existing YAML means config, prompts and template marker are preserved,
not upgraded. Init can write inputs, project identity and a first-publication
prefix before a later failure. Do not assume failure rolled effects back.

Initial root publication requires all four generated roots absent. A partial
generated-state rejection remains stopped; `--create-runtime` is not repair or a
merge operation. Use the [adoption decision](./state-adoption.md#choose-the-operation)
instead of selectively deleting roots. Configure real providers/routes/summarizer
before first server use; [configuration](../guides/configuration.md) owns that task.

## Start inputs

Select both the target and YAML explicitly for an identified deployment. Credentials must already be
provisioned privately in the service environment/credential file. This example
exports an existing value; it does not generate or print one:

```bash
export SAIVAGE_API_TOKEN
saivage start --project-root /work/project --config /work/project/.saivage/saivage.yaml --host 127.0.0.1 --port 8080
```

Only for an authorized initial publication may `--create-runtime` be added.
The [command-selection reference](../reference/configuration.md#command-specific-input-selection)
owns precedence and the different offline/control roots. Cwd alone does not pin
Start's root or YAML against inherited selectors. Intentional alternate service
YAML does not become the input to init, repair or reset; resolve their
[offline effective-input gate](./state-adoption.md#offline-command-inputs) first.

An invalid selected value fails, not falls through to another source. CLI/env port
accepts 0..65535; 0 requests an ephemeral OS port. Read the actual announcement.
IPv6 is bracketed; wildcard binds are explicitly qualified. Connect using a reachable
host with the actual port, not a wildcard URL. Binding does not prove reachability
or dual-stack coverage; the published lock control endpoint is separate authority.

`start` additionally accepts `--failed-provider-diagnostics <UUID>` and the
[Analyst MCP startup flags](./mcp.md#configure-the-inbound-listener).
`init` accepts only `--profile`; `repair` has its own exact target options.
`status`, `pause`, `resume`, `stop`, `restart_server`, `reset`, `help` accept no
options. Unknown/inapplicable options, positionals, missing values and repeated
singletons (even equal or mixed `--x=y`/`--x y`) fail before lock/write effects.
Exact command authority is `src/cli.ts`; startup selection is
`src/config/environment.ts`.

`NODE_ENV`, `LOG_LEVEL`, `SAIVAGE_API_TOKEN` are independent environment-only
inputs. Unset API token intentionally disables auth; set-but-blank or padded token
fails startup. In [expandable YAML values](../reference/configuration.md#owners-and-selected-input),
missing `${ENV_VAR}` interpolation becomes empty with redacted
`Configuration warning: ` diagnostics, not necessarily fatal validation. Correct
the actual service environment; warnings neither test credentials nor reload config.

### Child command environment

Ordinary children inherit only PATH, HOME, USER, LANG, TERM, `LC_*`,
GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL.
Saivage provides no Git identity defaults or startup identity probe; Git validates
at use. Provider/bearer tokens and unknown names, including GIT_CONFIG/GIT_SSH/
GIT_SSH_COMMAND, are not inherited. Runner root variables and explicit configured
command/stdio MCP overlays are separate; explicit overlays take precedence.
Do not turn scripts/argv/config into a secret-delivery channel. See
`src/runtime/command-policy.ts` for the exact inherited list.

Ordinary file tools and commands use native paths/cwd rules; relative paths default
to managed project context. A deployment mount is not a filesystem sandbox.

## Browser access across namespaces

Choose the access path before starting the listener. `127.0.0.1` belongs to the
network namespace of the calling process: a host browser cannot reach guest
loopback by using host loopback or changing the URL to the guest IP. A browser
inside the guest namespace can use `http://127.0.0.1:8080/` directly.

Where guest SSH is **already available and authorized**, run this in the
**operator host shell**, substituting the verified guest/user:

```bash
timeout -k 5s 3600s ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18080:127.0.0.1:8080 user@verified-guest
```

Keep that foreground session open and browse `http://127.0.0.1:18080/` on the host;
the destination loopback is evaluated in the SSH guest. Ctrl+C closes the forward;
the example also expires after one hour. It does not stop Saivage. A changed host
port is a different browser origin. The forward does not replace deployment-owned
isolation or trusted-origin requirements, especially for disabled authentication.
If SSH is unavailable, stop at this prerequisite or use an already authorized
confined access arrangement. Do not automatically install SSH, change firewall
rules or expose a wildcard listener.

## Authentication and public docs

`/health` and `/health/ready` are public registry-owned health contracts. All operator
`/api/*` resources—including redacted config, Doctor, events, processes and Debug—use
the published auth mode: bearer sends `Authorization: Bearer …`; deliberately disabled
mode sends no Authorization. Never put tokens in URLs. Authentication precedes request
validation/handler work. WebSocket is observation-only with its separate ticket flow;
submit internal Analyst turns via REST `POST /api/chat`, not old socket messages.

The SPA/static assets/docs are public, not evidence that protected API access works.
There is **no token login, token-entry, sign-out or provider-secret console in the UI**.
Provision a bearer browser through the procedure below; for failures use
[diagnosis](./diagnosis.md#unauthorized-ui-or-api), not storage reset or weakened auth.
Inbound Analyst MCP has an independent bearer
and loopback listener; the operator credential does not grant MCP access or vice versa.

`/docs` redirects to `/docs/`; the server serves installed `docs/.vitepress/dist`.
Full `npm run build` includes docs; `npm run docs:build` rebuilds docs alone from
matching source. Missing output returns 404; a missing page is a build/path problem,
not a reason to patch generated HTML or reset project state. Source/Pages hosting
can use another docs prefix, independent of runtime `/docs/` serving.

### Browser credential setup

1. Verify the trusted matching application assets and exact browser origin
   (scheme, host and port), over appropriate transport or the authorized tunnel.
   Use the already authorized **operator REST** credential, not a provider or MCP key.
2. Privately use the browser developer-tools storage editor for that origin to set
   local-storage key `saivage_api_token` to that credential. This is manual browser
   configuration, not a Saivage login UI. Never print/read it into logs, put it in
   a URL, chat, screenshot or commit, or paste a literal secret into console history.
3. Reload to recreate HTTP observations and the WebSocket ticket connection. Local
   storage is readable by same-origin scripts, not a secure credential vault.

The auth helper uses a **nonempty local value first**, including stale or whitespace
values without trimming. Empty/absent local storage falls through to the built
asset's `VITE_SAIVAGE_API_TOKEN`; empty/absent fallback sends no token. Setting the
server's `SAIVAGE_API_TOKEN` does not provision the browser. The build-time fallback
is existing behavior, not recommended secret provisioning: do not embed real bearer
credentials in public served bundles. Removing a local key does not remove a build
fallback. For deliberately disabled auth, no bearer is needed; remove stale local
configuration and account for any fallback using [diagnosis](./diagnosis.md#unauthorized-ui-or-api).

## Verify startup without starting work

1. Verify the exact launched executable, service user, project/config path and
   ownership. Startup takes lifecycle exclusion before full environment validation.
   Structural config/tool/route compilation precedes optional first root publication
   and strict current-state admission. Concrete capability/capacity binding happens
   **after** those steps in server composition. The lock is already a write effect;
   first publication and permitted admission tail truncations may remain after a
   binding failure. Credential/network validity remains a real-invocation concern,
   not a startup probe. See the [ordered startup owners](../architecture/system-architecture.md#startup-select-compile-admit-bind-listen).
2. Check actual bound announcement, public `/health` and `/health/ready`, static UI
   and docs, then authorized runtime/configured identity observations. Expected runtime
   is **stopped**, after any bounded authorized startup settlement. No automatic Run.
3. A listener/readiness failure remains a stopped incident; preserve known startup
   effects and use [diagnosis](./diagnosis.md#startup-does-not-reach-readiness).
   Do not loop starts, bypass locks or infer all-history fidelity from health.
4. Give the objective/brief and Run only under separate actual authorization. A
   benign provider check is also a provider call, not included in offline validation.

If deployment uses automatic service replacement, map server exit75 to the deployment's
restart policy deliberately. Delegating `saivage restart_server` returns an acknowledgement;
the **live server** exits75 after acknowledged cleanup. Neither proves replacement
startup/readiness. Reverify network confinement after an actual authorized restart,
including boot ordering/firewall dependency before first listener. Saivage does not
install that confinement or certify an existing unit's policy.

## Offline exclusion and complete backups

Before repair/reset/external migration, stop the exact service through its deployment
owner, prevent automatic restart and positively establish no server/project-owning
process or relevant descendant remains. Service inactivity alone is insufficient.
Use the [five-way lock classification](./runtime-control.md#five-ownership-outcomes);
live, malformed, indeterminate or ambiguous ownership blocks. Exact abandoned-lock
handling needs separate proof/authorization; no stale PID/PGID kill recipe.

Successfully complete a **full stopped target-project backup** under
`/home/salva/g/ml/tmp/` before generated inspection/transformation for migration or
input corrections/reset. Preserve it unchanged and maintain exclusion; reconfirm
before later steps if continuous exclusion is not established. Do not inspect
generated descendants to select a partial archive. Include selected image bytes,
established empty directories and outside inputs/credentials as part of the complete
target; keep sensitive archives private. Record path and successful completion,
not secrets/transcripts. File existence alone is not backup verification.

Backup is evidence, not mutable candidate, merge workspace, correctness guarantee,
small-loss bound or permission to restore. Repair has additional exact path/report
rules; [state adoption](./state-adoption.md) owns all consent/effect/cutover steps.

## Project discovery and exclusions

Optional root `.saivage-search-ignore` prunes literal project-root-relative directory
roots from recursive project `glob`/`grep` and `project:///` discovery. Example:

```text
# Keep required fixtures searchable; exclude narrow disposable outputs only.
artifacts/generated
artifacts/prior-runs
reports/scratch
```

Review source/tests/generators/manifests/evidence before excluding. Tracked and
untracked required fixtures must remain outside; never exclude a mixed `artifacts`
parent or conceal a failed check. Absent/empty policy means normal discovery;
invalid syntax/UTF-8/BOM or nonabsence read errors fail searches until corrected.
Exact reads, explicit-file searches, Files, shell/MCP/system/external native searches
and tests/generators are unchanged. This is not secrecy, deletion or provenance.
Read the exact ignore path or known excluded file to diagnose it. Reset preserves
this policy and target outputs; target cleanup requires a separate decision.
