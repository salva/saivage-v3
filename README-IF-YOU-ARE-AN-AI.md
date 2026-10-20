# AI-assisted LXC setup task

Use this task only when the owner has authorized setting up an identified Saivage
deployment. Your outcome is an isolated, verified installation and a usable
handoff—not an automatically started project. Reading this file, passing a build
or approving source changes grants no live-operation permission.

Explain each stage before effects; adapt commands to observed facts; report actual
changes, checks, limits and the next decision afterward. Stop at a consequential
conflict instead of silently replacing existing work. This is a subordinate task
guide: [AGENTS.md](AGENTS.md) governs repository work, the [runbook](docs/runbook/index.md)
owns procedures, and [agent navigation](docs/reference/agent-navigation.md) locates
exact contracts. Read the [overview](docs/overview.md) for the work model.

## Scope and credentials

The baseline is **one new privileged Ubuntu 24.04 classic-LXC guest**, dynamic
addressing, port 8080, no guest SSH and exactly `saivage.service`. Its tokenless
operator access is confined to the deployment host. Saivage neither creates nor
verifies external isolation. Trusted guest agents may execute as root; guest sudo
and bind mounts are capabilities, not containment controls.

Keep three roles distinct: host deployment administrator, host target owner, and
guest root used for provisioning. The target owner's actual username/UID and
primary group/GID determine the non-root guest service identity, not automatically
the administrator's identity.

**Host credentials are outside this task's trust boundary.** Never request or read
host passwords, SSH credentials or private keys; the user authenticates directly in
their own host terminal. The user may authorize you to install container-local
provider credentials and Saivage configuration, or enter them privately themselves.
Neither choice requires disclosing values in reports, argv, tracing, URLs,
repositories or host-wide configuration. Use a container-local secret source.
An enabled bearer goes only in `Authorization`, never a URL.

Fix these values once from discovery; substitute placeholders, not guessed paths:

| Identity | Mapping |
| --- | --- |
| Container | `<CONTAINER_NAME>`; rediscovered `<CONTAINER_IP>` |
| Saivage release | `<SAIVAGE_HOST_PATH>` ↔ `<SAIVAGE_GUEST_PATH>` |
| Managed target | `<TARGET_HOST_PATH>` ↔ `<TARGET_GUEST_PATH>` |

The command/configuration blocks below are **installation examples**, not a script
to run against an arbitrary host. Provisioning, service start, guest restart and
provider interaction must be within the owner's actual authorization. No deployment
was performed by this documentation change.

## Stage 1 — Identify the target and permission

Inspect without mutation: classic LXC availability, host architecture/network,
supported Node/npm, absolute release/target paths, Git dirt, container-name use,
existing target inputs/state and the target's actual owner identity. Read workspace
handoff/memory where applicable; historical IPs and unit names are not current facts.
Use exact deployment/ownership observations rather than enumerating generated
descendants. Establish any existing lifecycle owner through the
[five-way classification](docs/runbook/runtime-control.md#five-ownership-outcomes).

Ask only for missing paths, unavailable administrator access, authorization not
already given or resolution of a concrete conflict. Do not reopen baseline choices
about distribution, SSH, port, unit name or customization unnecessarily. Never
overwrite a used container, config, unit, project authority or unrelated Git work.

**Checkpoint:** report the selected identities, mappings, authorization and
conflicts. If this is not a fresh setup, route its retained state through
[state adoption](docs/runbook/state-adoption.md#choose-the-operation); do not turn
this fresh-install task into an upgrade/reset/migration by inference.

## Stage 2 — Build the release and fix mounts

Select a coherent, identified release. Preserve unrelated source changes; do not
silently deploy an evolving shared development checkout. From its host build root:

```bash
cd "<SAIVAGE_HOST_PATH>"
npm ci
npm --prefix web ci
npm run build
```

Require Node `>=24 <25` and npm `>=10 <12`; prefer the latest supported Node 24 LTS
patch. Preserve native optional dependencies, packaged prompts, compiled modules,
web assets and built docs. See [build/install and native image prerequisites](docs/runbook/deployment.md#build-and-install).

Plan one read-only release bind and one read-write target bind. The target holds
source and project-local `.saivage`, never `~/.saivage`. If Saivage itself is the
managed target, explicitly use one non-overlapping read-write mapping instead of
contradictory binds. Classic LXC relative mount destinations are the verified guest
paths without their leading slash.

**Checkpoint:** successful build, exact source/release identity, four absolute
paths and mount modes. A copy/read-only release mount does not isolate target
commands from the host; external isolation still must be established.

## Stage 3 — Provision the isolated guest

After proving the name unused, create the authorized Ubuntu 24.04 classic-LXC
guest. Adapt image/package sources to actual architecture and host facts. Keep
dynamic addressing and no SSH server. Provision Node 24/npm in range, nftables,
sudo, Git, CA certificates and required runtime/native libraries, then install
the Stage 2 binds.

Before creating/reusing a service user, check username, UID, group and GID conflicts.
Match the target owner's username/UID and primary group/GID where practical; stop
for explicit resolution of unrelated collisions. Grant passwordless sudo only in
the isolated guest. Do not change host ownership or make the target world-writable.

As the **runtime user**, verify the built entrypoint is readable and perform one
harmless create/remove probe in `<TARGET_GUEST_PATH>`. Guest-root `test -w` is not
evidence of runtime-user access.

**Checkpoint:** report versions, actual dynamic address, the three-role identity
mapping, guest sudo, exact mounts/modes and runtime-user probe result.

## Stage 4 — Initialize and configure without state loss

Only a fresh target follows this initialization path. From `<TARGET_GUEST_PATH>`,
as runtime user, run the selected built entrypoint:

```bash
node "<SAIVAGE_GUEST_PATH>/bin/saivage.js" init
```

Select optional `--profile classic-typed` or `--profile paad-typed` only before
configuration exists. Existing-config init preserves YAML, prompts and marker;
it does not switch profiles. Preserve configuration, identity, credentials and
generated state. Report pre-existing versus newly published configuration,
identity and generated state, pre-acquisition identity/lock observation and
post-validation result separately. See [initialization](docs/runbook/deployment.md#initialize-only-a-fresh-target)
and [direct persistence](docs/spec/system-specification.md#direct-file-persistence).
See [storage and interruption](docs/runbook/state-adoption.md#storage-and-interruption)
for exact consumption and loss boundaries.

An old/mixed/malformed/partial-state rejection stops setup. Do not inspect generated
descendants, selectively edit files, retry uncertain publication or improvise reset.
Before any separately authorized repair/reset/migration: stop the exact service,
prevent automatic restarts, positively establish **no live owner or relevant
process**, and successfully complete a **fresh full stopped target-project backup**,
preserved unchanged. A malformed/indeterminate/live owner blocks; abandoned-lock
handling needs separate proof/authorization. Use the complete
[exclusion/backup procedure](docs/runbook/deployment.md#offline-exclusion-and-complete-backups)
and [adoption decision](docs/runbook/state-adoption.md#choose-the-operation), not a
setup shortcut. A backup's existence is not proof that it completed successfully.

Ask now for authorized provider/model and spending constraints. Keep the complete
generated topology; configure every required named route and one exact enabled
compaction `summarizer_candidate` (provider, nullable account, model). Choose a
strong tool-capable model with the actual selected transport/image capabilities,
not an invented capability declaration. Follow the
[configuration tasks](docs/guides/configuration.md#wire-provider-routes-and-summary)
and [field reference](docs/reference/configuration.md).

For a container-local environment file, establish exact absence before creating it.
If present, merge only intended entries and preserve unrelated variables; never
truncate first or print its contents. Keep `SAIVAGE_API_TOKEN` absent for this
host-only tokenless baseline. Structural config validity is not credential or
provider commissioning evidence.

**Checkpoint:** valid routes/summary, preserved inputs/topology, credential names
and private location only; no secrets in repository or host-wide configuration.

## Stage 5 — Confine access before installing the listener

No first listener until initialization/current-format admission and network
confinement succeed. Headerless operator APIs are admitted when the API token is
unset. `0.0.0.0:8080` is not access control, and the UI has no token-entry screen.
See [authentication](docs/runbook/deployment.md#authentication-and-public-docs).

The following complete firewall example applies **only** to an inspected clean
Ubuntu guest with no operator/custom nftables policy. Positively establish the
source address by which the deployment host reaches the guest. Existing/custom
policy or an unknown host address stops this baseline; obtain a deliberate network
design, never merge/flush/normalize existing policy as a convenience.

As guest root, install `/etc/nftables.conf`, substituting the verified host IPv4.
Include the IPv6 accept line only for a positively verified host IPv6 path;
otherwise the final reject denies non-loopback IPv6. `flush ruleset` is permitted
only by the clean-baseline precondition:

```nft
#!/usr/sbin/nft -f
flush ruleset

table inet saivage {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "lo" tcp dport 8080 accept
    ip saddr <DEPLOYMENT_HOST_IPV4> tcp dport 8080 accept
    # ip6 saddr <DEPLOYMENT_HOST_IPV6> tcp dport 8080 accept
    tcp dport 8080 reject
  }
}
```

After installing nftables, all these checks must succeed **before Saivage starts**:

```bash
nft -c -f /etc/nftables.conf
systemctl enable nftables.service
systemctl restart nftables.service
systemctl is-enabled --quiet nftables.service
systemctl is-active --quiet nftables.service
nft list table inet saivage
```

Install this complete unit at `/etc/systemd/system/saivage.service`. Substitute
verified runtime user/group, Node executable and absolute paths. Retain
`EnvironmentFile` for the container-local secret source; omit only if none is
needed. Any pre-existing unit needs inspection and approval before replacement.

```ini
[Unit]
Description=Saivage autonomous development service
Wants=network-online.target
Requires=nftables.service
After=network-online.target nftables.service

[Service]
Type=simple
User=TARGET_OWNER_RUNTIME_USER
Group=TARGET_OWNER_RUNTIME_GROUP
WorkingDirectory=<TARGET_GUEST_PATH>
EnvironmentFile=/etc/saivage/saivage.env
ExecStart=/absolute/path/to/node <SAIVAGE_GUEST_PATH>/bin/saivage.js start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Verify the installed file and systemd's effective user/group, cwd, environment
**source**, command, `Requires` and `After`, without exposing secret values. Reload
and start only after those checks:

```bash
systemctl daemon-reload
systemctl enable --now saivage.service
systemctl is-active --quiet nftables.service
systemctl is-active --quiet saivage.service
nft list table inet saivage
```

Use bounded, secret-safe unit/journal observations on failure. Do not dump effective
environment or provider config. Startup may settle an interrupted current-format
chain but leaves execution stopped; readiness never authorizes Run. Failed startup
permits no compatibility start, automatic reset or repeated uncertain operation.

**Checkpoint:** loaded canonical confinement before first listener, correct unit
dependency/identity and exact-process health. Continue to durable restart testing;
initial reachability is not completion.

## Stage 6 — Verify restart confinement and teach first use

Verify guest-loopback and deployment-host `/health`, `/health/ready`, UI and a
headerless operator API request; inspect the loaded firewall. Use naturally
available non-host IPv4/IPv6 paths to check rejection. Never weaken confinement
to manufacture a probe; an unavailable negative probe is **unavailable**, not passed.

The enabled tokenless baseline requires an **actual guest restart**, through the
authorized classic-LXC administrator path, then rediscovery of its dynamic IP:

```bash
sudo lxc-stop -n "<CONTAINER_NAME>"
sudo lxc-start -n "<CONTAINER_NAME>"
```

After restart, reverify nftables success/exact table, active Saivage with its required
unit satisfied, loopback/host health/readiness/UI/API, available negative probes,
root/current records and configured session readability, and absence of a current
restart-required error. If restart cannot be performed, or a mandatory rule,
dependency or positive reachability check fails, use classic `lxc-attach` to
**stop and disable `saivage.service`**. Report incomplete; do not leave or describe
an enabled tokenless installation as durably confined.

With actual provider-call authorization, require one benign real Analyst interaction
to distinguish working credentials from offline validation. Teach
[Cockpit, Files, System and the five card facets](docs/guides/operating.md), exact
records/conversations/evidence and `/docs/`. Explain that bundled Oversight is
read-only apart from notifications and waits a full configured interval after Run;
its absence before a first check is not a failed provider probe.

Inspect existing project authority; ask unresolved objective/constraint/acceptance
questions only. Have the Analyst align the root brief and obtain objective approval.
**Do not start autonomous work as a side effect of setup or the provider check.**

**Checkpoint:** distinguish reboot/network observations, unavailable probes, actual
provider result and approved objective. Ask for a later explicit Run decision; if
Run was already specifically authorized, perform it only as that separate action
and report its actual result, never infer it from service readiness.

## Stage 7 — Hand off and separate later operations

Leave a secret-free handoff: URL/access boundary, exact container/unit/release,
runtime user, both mappings, provider/model names, credential location, health/log/
rebuild commands, verification evidence, unresolved items and whether execution is
stopped or separately authorized Run actually occurred. Link the installed `/docs/`
and [runbook](docs/runbook/index.md), not a copied policy wall.

Teach the three lifecycle layers: `saivage stop` contains **project** work; systemd
controls the **server**; classic LXC controls the **guest**. Tokenless mode has no
authenticated public `restart_server` capability; use the authorized unit operation.
Project Stop does not close Analyst or inbound MCP listeners. See
[runtime control](docs/runbook/runtime-control.md).

Later state operations remain distinct, never automatic setup fallback:

* [Current-format repair](docs/runbook/state-adoption.md#current-format-repair)
  needs its exact offline target/report/consent gates; previous slots are not normal
  fallback or old-format converters.
* [Destructive reset](docs/runbook/state-adoption.md#destructive-reset) requires
  explicit loss consent after exclusion and successful complete preserved backup.
  Current built `saivage reset` replaces `.saivage/cards`, `.saivage/agents`,
  `.saivage/logs` and `.saivage/work` wholesale;
  **cards, records, conversations and history are permanently lost**. Configuration,
  credentials, identity, operator inputs, source and docs remain outside those roots.
* [External offline migration](docs/runbook/state-adoption.md#explicit-external-offline-migration)
  requires an explicit identified-project request, stopped exclusion, successful
  complete preserved backup, independent complete candidate, actual strict complete
  validation, confirmed concrete loss and authorized complete-boundary cutover.

Do not inspect/adopt/clean unreferenced files. Startup is not all-history
certification or remembered write authority. Publication uncertainty stops effects
without follow-up inspection, retry, cleanup or rollback. Restart verification and
Run remain separate actual authorizations after any state operation.

Only after baseline handoff offer deliberate alternatives: bearer/remote access,
custom firewall/bridge/proxy/TLS, guest SSH using approved public keys, unprivileged
UID mapping, other providers and workflow/prompt/MCP/skill customization. Broader
reachability requires bearer authentication and a separately reviewed network design.

**Completion:** report verified versus unexecuted steps honestly. No setup prose,
static review or health result establishes provider perception, future containment,
complete historical fidelity or automatic permission for the next operation.
