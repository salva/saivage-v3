# Set Up Saivage as an AI Agent

Saivage turns a software goal into a visible tree of cards. Planners decompose
work, executors perform terminal cards, reviewers assess results, and the
runtime alone dispatches them. The Analyst is the ordinary operator and
mutation surface. All of this runs inside an externally isolated container;
the deployment supplies that boundary, not Saivage.

Guide the user through seven short stages: inspect, build, create and provision,
initialize and configure, confine and start, verify and learn, then hand off.
Before each stage, explain the objective and why it matters. Inspect the actual
host, choose capable host-specific commands, and preserve the constraints below
rather than treating this guide as a portable script. After each stage, report
actual changes, checks, blockers, and what comes next. Ask consequential
questions only when they become necessary.

The baseline is one new privileged Ubuntu 24.04 classic-LXC guest with dynamic
addressing, port `8080`, no guest SSH, and one service named exactly
`saivage.service`. Operator access is tokenless but confined to the deployment
host. Broader networking and customization are later choices.

Use only these path and container placeholders, fixed once after discovery:

- `<CONTAINER_NAME>` and discovered `<CONTAINER_IP>`
- `<SAIVAGE_HOST_PATH>` ↔ `<SAIVAGE_GUEST_PATH>`
- `<TARGET_HOST_PATH>` ↔ `<TARGET_GUEST_PATH>`

## Credential boundary

Host passwords, host SSH credentials and private keys, and other host-side
credentials are outside your trust boundary: never request or read them. When
needed, the user authenticates directly in their own host terminal. Secrets
whose scope and use are confined to the isolated Saivage container, including
provider credentials and container-local Saivage configuration, may be given to
and installed by you when the user chooses; secure local entry is an equal
alternative, not mandatory ceremony. In either case, never repeat secrets in
reports, expose them in command arguments, tracing, or output, write them to a
repository, place them in a host URL, or install them in broader host
configuration. Provider configuration should refer to a container-local secret
source rather than contain repository values.

## Stage 1 — Explain and inspect

**Objective.** Establish the real host, project, identities, network, and
conflicts without changing anything.

**Rationale.** Host assumptions make setup brittle. In particular, three roles
must remain distinct:

1. the host deployment administrator, who operates classic LXC;
2. the host target owner, whose username, UID, primary group, and GID define the
   non-root guest runtime identity; and
3. guest root, used only to provision the externally isolated container.

**Constraints and actions.** Read the current repository authorities and inspect
classic LXC availability, host architecture/network facts, Node and npm
versions, both absolute paths, source and target Git dirt, existing containers,
existing target `.saivage` state, and the target directory's actual owner
identity. Verify that `<CONTAINER_NAME>` is unused. Saivage requires Node
`>=24 <25` and npm `>=10 <12`.

Do not ask baseline questions about SSH, remote access, port, service name,
distribution, model catalog, or workflow customization. Ask only for a missing
path or unavailable administrator access, or for approval to resolve a concrete
conflict. Never clean unrelated work or overwrite a container, state, config,
unit, or project authority.

**Outcome.** Report the selected non-secret facts, all three roles, any
conflicts, and the next action. Make no mutation during this stage.

## Stage 2 — Build and establish the mount model

**Objective.** Build the current checkout and fix one unambiguous source/target
mount layout.

**Rationale.** Building on the host avoids a second source checkout. Saivage
source is normally read-only in the guest; the target must be read-write because
agents edit it and keep project-local state at `<TARGET_GUEST_PATH>/.saivage`.
Never use `~/.saivage`.

**Constraints and actions.** Preserve unrelated source changes. With supported
Node/npm, use the repository build contract:

```bash
cd "<SAIVAGE_HOST_PATH>"
npm ci
(cd web && npm ci)
npm run build
```

Fix both host paths and both absolute guest destinations once. Plan exactly one
read-only source bind and one read-write target bind. If Saivage itself is the
target, use one non-overlapping read-write mapping instead. In classic LXC
configuration, derive each relative destination by removing the leading slash
from the corresponding `<SAIVAGE_GUEST_PATH>` or `<TARGET_GUEST_PATH>`; do not
substitute unrelated literal destinations.

**Outcome.** The build succeeds, the four path values and mount modes are
reported, and no overlap or contradictory mount entry remains.

## Stage 3 — Create and provision the guest

**Objective.** Create the simple guest, install the runtime prerequisites, and
prove the matched runtime identity can use both mounts.

**Rationale.** A privileged Ubuntu 24.04 guest keeps direct bind-mount ownership
understandable. Matching the target owner lets host and guest attribute project
files to one identity. Trusted agents receive passwordless sudo only inside the
external isolation boundary.

**Constraints and actions.** Only after proving `<CONTAINER_NAME>` unused,
create one Ubuntu 24.04 classic-LXC guest. Adapt architecture, image source,
package source, and package commands to inspected host/guest facts. Keep dynamic
addressing, no SSH server, Node 24, npm `>=10 <12`, nftables, sudo, Git, CA
certificates, and necessary runtime tools as the baseline. Install the two bind
mounts using only the Stage 2 mappings and modes.

Before creating or reusing the guest runtime user, check username, UID, group,
and GID conflicts. Match the host target owner's username and UID, and its
primary group/GID where practical; this identity is not automatically the host
administrator. Grant it passwordless sudo inside the guest. On any unrelated
name or numeric-ID collision, stop for an explicit resolution. Do not change
host ownership or make the target world-writable.

Verify the built Saivage entry point is readable. As the runtime user—not guest
root—perform one harmless create and remove operation in
`<TARGET_GUEST_PATH>`. A root `test -w` is not evidence.

**Outcome.** Report guest and Node/npm versions, dynamic address, the three-role
identity mapping, passwordless guest sudo, exact mounts and modes, source
readability, and the successful runtime-user write/remove probe.

## Stage 4 — Initialize and configure

**Objective.** Initialize current durable identity/state, then configure a real
provider without destroying existing configuration or secrets.

**Rationale.** Initialization and provider setup are separate. The generated
default supplies all nine workflows, named model-route/profile scaffolding,
enabled compaction, and a summarizer candidate, but `providers` is empty and no
credential is supplied. Offline structural compilation does not contact a
provider.

**Constraints and actions.** From `<TARGET_GUEST_PATH>`, run the current built
`saivage init` as the runtime user. Explain its six ordered phases:

1. read project identity before acquisition to select a bound or
   bootstrap-unbound lock record;
2. exclusively publish the init lifecycle lock;
3. publish `.saivage/saivage.yaml` only when it is missing;
4. load and validate the effective configuration and selected workflows;
5. read identity again and, only when absent, create it and bind the held lock;
6. classify generated state, accepting a valid project card or publishing
   initial state only when all four generated roots—`.saivage/cards`,
   `.saivage/agents`, `.saivage/logs`, and `.saivage/work`—are absent.

The first identity read is non-mutating. A known-unsuccessful exclusive lock open
publishes no new lock; failure after that open is outcome-unknown, halts, and may
retain the lock. After successful acquisition, ordinary failure releases the
exact current lock, whether bootstrap-unbound or bound, but does not roll back
completed config, identity, or generated durable effects. If identity creation
completes and lock binding fails, the identity remains. Publication uncertainty
is fatal, may retain its target and lock, and authorizes no inspection, retry,
repair, or rollback.

Classification performs no generated-state publication, deletion, selective
repair, or rollback. Its strict canonical project-card read may truncate only
an identifiable unterminated final suffix before parsing. If truncation
completion cannot be confirmed, the outcome is fatal/unknown and authorizes no
follow-up read, retry, repair, or recovery. Earlier config or identity effects
remain; generated-publication failure may retain partial state and the lock.

`saivage reset` is a separate explicit destructive decision, run with the
service confirmed stopped. It replaces the four generated roots wholesale;
there is no `init --force` and no selective repair.

Preserve the complete generated topology. Ask now about authorized provider and
cost constraints, choose a strong current tool-capable model by default, and
change only what that provider requires. Configure every required named route
and the exact enabled-compaction `summarizer_candidate`; the candidate must name
one configured provider, nullable account, and model.

Apply the credential boundary above. For a container-local environment file,
first determine whether it exists. Create it only on exact absence. If present,
merge the intended entry while preserving every unrelated variable; never use a
truncate-first operation. Let the user enter values locally or install them when
authorized, without exposing them. Keep `SAIVAGE_API_TOKEN` absent for this
host-only baseline.

**Outcome.** Report the pre-acquisition identity observation and selected lock
record kind separately from the post-validation reread. Distinguish pre-existing
from newly published config, identity, and generated state. Report structurally
valid routes/compaction and required credential names—not values—and confirm no
secret entered repository or host-wide configuration.

## Stage 5 — Confine access, install, and start

**Objective.** Establish host-only access before the first listener, then install
one correctly ordered systemd service.

**Rationale.** Without `SAIVAGE_API_TOKEN`, operator routes accept headerless
requests. Binding `0.0.0.0:8080` is not access control. A persisted firewall
loader must succeed before the enabled listener can start after reboot.

**Constraints and actions.** This baseline applies only after inspection proves
a clean Ubuntu guest with no operator or custom nftables policy and positively
identifies the source address by which the deployment host reaches the guest.
Never guess that address. If firewall state is existing or custom, stop this
baseline and use the deliberate network-design option in Stage 7; do not merge,
replace, or normalize it.

As guest root, install the following as the canonical
`/etc/nftables.conf`, substituting only the verified deployment-host source
address. Include the IPv6 accept line only when the host's IPv6 path to the guest
is positively verified; otherwise the final reject denies non-loopback IPv6.
`flush ruleset` is allowed only under the clean-baseline precondition.

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

After installing the guest `nftables` package, run every check below before
Saivage may start. Inspect the listed table. Any failure stops setup; do not
improvise another baseline firewall.

```bash
nft -c -f /etc/nftables.conf
systemctl enable nftables.service
systemctl restart nftables.service
systemctl is-enabled --quiet nftables.service
systemctl is-active --quiet nftables.service
nft list table inet saivage
```

Now install this complete unit at exactly
`/etc/systemd/system/saivage.service`—do not merely display it. Substitute the
verified runtime user/group and absolute paths. Keep `EnvironmentFile` when the
provider uses that container-local source; omit it only when no environment
source is needed.

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

Inspect an existing Saivage unit and obtain approval before replacement. Before
starting, verify the file exists and inspect systemd's effective view for the
user, group, working directory, environment source, command, `Requires`, and
`After`. Only then reload, enable, and start exactly `saivage.service`:

```bash
systemctl daemon-reload
systemctl enable --now saivage.service
systemctl is-active --quiet nftables.service
systemctl is-active --quiet saivage.service
nft list table inet saivage
```

Use bounded, secret-safe `systemctl`/`journalctl` output to diagnose failure;
never dump the environment or provider configuration.

**Outcome.** Before start, the canonical rule parses and is loaded and the
installed unit's effective dependencies and identity are correct. After start,
both units are successful, the exact table remains loaded, and bounded state,
logs, and health show a healthy process.

## Stage 6 — Verify and teach first use

**Objective.** Prove durable host-only operation and teach the user the normal
Saivage workflow.

**Rationale.** Initial startup does not prove reboot confinement or provider
credentials. A user should also understand the system before autonomous work
mutates the project.

**Constraints and actions.** Verify health and readiness from guest loopback and
the deployment host, open the UI at `http://<CONTAINER_IP>:8080/`, and verify a
headerless operator API request from the host. Inspect the loaded rules. Test
rejection from a naturally available non-host IPv4/IPv6 path; do not weaken the
boundary to manufacture a probe, and report an unavailable negative probe as
unavailable rather than passed.

An enabled tokenless deployment is not complete yet. From the deployment host,
restart the actual guest through the classic-LXC administrator path, then
rediscover `<CONTAINER_IP>`:

```bash
sudo lxc-stop -n "<CONTAINER_NAME>"
sudo lxc-start -n "<CONTAINER_NAME>"
```

After that actual restart, prove all of the following again:

- `nftables.service` succeeded and the exact `inet saivage` table is loaded;
- `saivage.service` is active with its required unit satisfied;
- guest-loopback and deployment-host health/readiness/UI/API probes succeed;
- any naturally available non-host probe is still rejected.

If the restart cannot be performed, or any mandatory rule, dependency, or
positive reachability check fails, use classic `lxc-attach` to stop and disable
`saivage.service`. Report setup incomplete; never leave or describe an enabled
tokenless service as durable.

Require one real provider-backed Analyst interaction. Explain Dashboard runtime
state, the root card and children, Analyst conversation, and Files, Agents, and
Debug. The Analyst is the ordinary mutation surface. Inspect existing project
authority and ask only the unresolved goal, constraint, and acceptance
questions. Have the Analyst align the root brief to that accepted authority and
obtain user approval before autonomous work begins.

**Outcome.** Host-only tokenless reachability and successful firewall dependency
are established before and after the guest restart; inspected semantics and
available probes reject unintended access; one provider call succeeds; and the
user can identify the main UI concepts and approve the project objective.

## Stage 7 — Hand off and present later options

**Objective.** Leave concise, secret-free operations guidance and separate the
working baseline from deliberate customization.

**Rationale.** Routine maintenance needs no guest SSH, and project, service, and
container lifecycle are different authorities.

**Constraints and actions.** Report the URL and access boundary, container and
`saivage.service`, both host/guest mappings, provider/model names, credential
location but not values, health/log/rebuild operations, and unresolved items.
Use host classic `lxc-attach` with guest `systemctl` and `journalctl` for routine
maintenance. `saivage stop` stops the project runtime; systemd controls the
server process; classic LXC controls the guest. In tokenless mode, confirmed
application-level `restart_server` is unavailable, so restart the server through
`saivage.service`.

Only now offer compact, deliberate alternatives: bearer authentication and
remote access; custom firewall, bridge, proxy, or TLS design; guest SSH using
approved public keys; unprivileged UID mapping; alternate providers/models; and
workflow, prompt, MCP, or skill customization. Broader reachability requires
bearer authentication and a separately reviewed network design.

**Outcome.** The user receives a complete non-secret handoff, understands the
three lifecycle layers, and can choose later options without confusing them with
the verified baseline.

This guide defines setup outcomes; it does not claim that this documentation
change performed live LXC, nftables, systemd, or guest-restart validation.
