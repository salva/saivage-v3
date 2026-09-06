---
name: saivage-lxc-operations
description: 'Operate local LXC deployments that matter to Saivage v3: the v2-on-v3 harness, Saivage v3 running against GetRich v2, Pueblicos, and jsqlite. Use when checking deployment health, inspecting or restarting exact services, verifying bind mounts and units, confirming container IPs, diagnosing lifecycle-lock startup blockers, manually repairing a lock after positive dead-owner classification and no-owner verification, or handling network-outage failed cards.'
---

# Saivage v3 LXC Operations

Project runtime controls are not deployment discovery. CLI `status`, `pause`, `resume`, and `stop` may delegate only through a verified live lifecycle lock's published non-null origin/auth mode; never substitute container config, current YAML, host/port defaults, or service environment. CLI `stop` calls `stop_project` and leaves the server/lifecycle lock alive. Use service/container procedures only for terminal disposal, deployment restart, or maintenance; auth-enabled confirmed `restart_server` remains distinct.

Use this skill for LXC-backed operations around the Saivage v3 implementation and
the target projects it manages. It is not the general workspace LXC playbook.

## Do Not Use For

- Operating the old `saivage` v2-on-GetRich deployment unless the user explicitly asks for that legacy service.
- Resetting target-project `.saivage/` state; use `saivage-project-reset` for resets.
- Editing OpenCode state, skills, sessions, or `.opencode/` config.
- Broad container maintenance unrelated to Saivage v3.

## Ground Rules

- Work from `/home/salva/g/ml/saivage-v3` for Saivage v3 source/build commands.
- Prefer passwordless SSH for in-container inspection and service control. Use `root@<ip>` for privileged actions and `salva@<ip>` for non-privileged inspection.
- For host-level LXC commands when interactive `sudo` is unavailable, use passwordless root SSH to the host itself: `ssh root@localhost 'lxc-ls --fancy'`.
- Fall back to classic LXC commands only for container lifecycle, broken SSH access, reading `/var/lib/lxc/<name>/config`, or when a container has no IP.
- Use classic LXC commands on this host: `sudo lxc-ls --fancy`, `sudo lxc-info -n <container>`, and `sudo lxc-attach -n <container> -- <command>`.
- Do not use `lxc exec` or `lxc list`; this host uses classic LXC tooling.
- Secret-bearing files such as `.saivage/saivage.yaml`, `.saivage/auth-profiles.json`, env files, shell history, or token files may be inspected or edited when needed. Do not print secret values in chat or logs.
- API bearer tokens must not be placed in URLs.
- Use `/home/salva/g/ml/tmp/` for temporary artifacts.
- A crash loop, reboot history, failed health probe, elapsed time, stopped unit, process list, or listener observation does not classify a lifecycle lock. Use only the current installed or bind-mounted Saivage CLI's five-way classifier. Never remove a lock or take over automatically; `indeterminate`, `malformed`, and every ambiguous observation fail closed.

## Saivage v3-Relevant Deployments

| Container | URL | Service | SSH root | Host paths | Purpose |
| --- | --- | --- | --- | --- | --- |
| `saivage-v3` | `http://10.0.3.112:8080/health` | `saivage.service` | `root@10.0.3.112` | `/home/salva/g/ml/saivage-v3` target mounted at `/work/saivage-v3` | Dedicated Saivage v2 harness working on the Saivage v3 source repo. |
| `saivage-v3-getrich-v2` | `http://10.0.3.170:8080/health` | `saivage-v3-getrich.service` | `root@10.0.3.170` | `/home/salva/g/ml/saivage-v3` mounted at `/opt/saivage-v3`; `/home/salva/g/ml/getrich-v2` mounted at `/work/getrich-v2` | Saivage v3 runtime managing GetRich v2. |
| `pueblicos` | `http://10.0.3.52:8080/health` | `saivage-pueblicos.service` | `root@10.0.3.52` | `/home/salva/g/ml/saivage-v3` mounted at `/opt/saivage-v3`; `/home/salva/g/ml/pueblicos` mounted at `/work/pueblicos` | Saivage v3 runtime managing Pueblicos (port 8080, auth disabled). |
| `saivage-jsqlite` | `http://<current-ip>:8081/health` | `saivage-jsqlite.service` | `root@<current-ip>` | `/home/salva/g/ml/saivage-v3` mounted at `/opt/saivage`; `/home/salva/g/ml/jsqlite` mounted at `/work/jsqlite` | Saivage v3 runtime managing jsqlite (port 8081, auth disabled). Its IP changes across host reboots (seen: 10.0.3.225, .248, .238); always resolve the current IP via `ssh root@localhost 'lxc-ls --fancy'`. |

Verify live container IPs before operational changes; old health snapshots may be stale.

## Standard Health Checks

Run from the host:

```bash
curl -fsS --max-time 5 http://10.0.3.112:8080/health || true
curl -fsS --max-time 5 http://10.0.3.170:8080/health || true
curl -fsS --max-time 5 http://10.0.3.52:8080/health || true
```

If health fails, confirm container state/IPs before changing services:

```bash
sudo lxc-ls --fancy
sudo lxc-info -n saivage-v3
sudo lxc-info -n saivage-v3-getrich-v2
sudo lxc-info -n pueblicos
```

## Inspect Services

Prefer SSH:

```bash
ssh root@10.0.3.112 'systemctl status saivage.service --no-pager'
ssh root@10.0.3.170 'systemctl status saivage-v3-getrich.service --no-pager'
ssh root@10.0.3.52 'systemctl status saivage-pueblicos.service --no-pager'
```

Inspect recent logs without printing secrets unnecessarily:

```bash
ssh root@10.0.3.112 'journalctl -u saivage.service -n 120 --no-pager'
ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service -n 120 --no-pager'
ssh root@10.0.3.52 'journalctl -u saivage-pueblicos.service -n 120 --no-pager'
```

Inspect process/listening state:

```bash
ssh root@10.0.3.170 'ps -ef | grep -E "node|saivage" | grep -v grep; ss -ltnp | grep :8080 || true'
ssh root@10.0.3.52 'ps -ef | grep -E "node|saivage" | grep -v grep; ss -ltnp | grep :8080 || true'
```

## Restart Services

Restart only the intended Saivage v3-related service:

```bash
ssh root@10.0.3.112 'systemctl restart saivage.service && systemctl is-active saivage.service'
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
ssh root@10.0.3.52 'systemctl restart saivage-pueblicos.service && systemctl is-active saivage-pueblicos.service'
```

Then probe the matching health endpoint.

## Build Before Restarting v3 Runtime Deployments

For deployments that bind mount `/home/salva/g/ml/saivage-v3` into
`/opt/saivage-v3`, build the source repo before restart when TypeScript/runtime
code changed:

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

For Pueblicos:

```bash
cd /home/salva/g/ml/saivage-v3
npm run build
ssh root@10.0.3.52 'systemctl restart saivage-pueblicos.service && systemctl is-active saivage-pueblicos.service'
curl -fsS http://10.0.3.52:8080/health
```

## Verify Bind Mounts And Service Commands

Use this before resets, deployment diagnosis, or when paths appear inconsistent:

```bash
sudo sed -n '1,220p' /var/lib/lxc/saivage-v3-getrich-v2/config | rg 'lxc.mount.entry|saivage-v3|getrich-v2'
sudo sed -n '1,220p' /var/lib/lxc/pueblicos/config | rg 'lxc.mount.entry|saivage-v3|pueblicos'
```

Read systemd units when the service command is uncertain:

```bash
ssh root@10.0.3.170 'systemctl cat saivage-v3-getrich.service'
ssh root@10.0.3.52 'systemctl cat saivage-pueblicos.service'
```

Expected command shape for Saivage v3 target deployments is a Node process that
runs `/opt/saivage-v3/bin/saivage.js start` or equivalent against the mounted
target project. Verify the real unit before editing or manually starting.

## Runtime File Inspection

Target-project Saivage files are project-local:

- GetRich v2: `/home/salva/g/ml/getrich-v2/.saivage/` and `/home/salva/g/ml/getrich-v2/.saivage/work/`.
- Pueblicos: `/home/salva/g/ml/pueblicos/.saivage/` and `/home/salva/g/ml/pueblicos/.saivage/work/`.

Safe canonical files to inspect when diagnosing behavior include event/error logs,
cards, records, and conversations. Runtime lifecycle and provider availability are
process-local; there is no durable runtime-state, snapshot, or availability file.
Avoid printing provider configs or auth profiles.

## Lifecycle-Lock Classification And Manual Repair

Use this singular fail-closed sequence when a power outage, hard reboot,
startup failure, port conflict, or service crash loop suggests a lifecycle-lock
blocker. Those symptoms do not prove abandonment. This procedure prevents
likely wrong-project or overlapping-owner accidents; it is not containment of a
trusted root-capable agent.

Pueblicos examples use unit `saivage-pueblicos.service`, project
`/work/pueblicos`, and port 8080. For jsqlite, resolve and use its exact current
values, normally unit `saivage-jsqlite.service`, project `/work/jsqlite`, and
port 8081.

1. **Resolve the exact deployment identity.** Record the current container IP,
   canonical target-project root, exact systemd unit, current installed or
   bind-mounted CLI entry point, Node executable, expected host/port, and unit
   command. Verify rather than infer these from an old incident:

   ```bash
   ssh root@localhost 'lxc-ls --fancy'
   ssh root@<ip> 'systemctl cat <exact-unit>'
   ```

2. **Stop only the exact unit, then inspect it separately.** Do not combine
   observation with lock deletion or service startup:

   ```bash
   ssh root@<ip> 'systemctl stop <exact-unit>'
   ssh root@<ip> 'systemctl show <exact-unit> --property=ActiveState --property=SubState --property=MainPID --no-pager'
   ```

   Require `MainPID=0` and an inactive or failed, non-restarting state. An owner
   PID, activation/restart in progress, unknown state, or ambiguous output
   stops recovery.

3. **Collect positive project-bound no-owner evidence.** With the unit still
   stopped, list candidate Node/Saivage server PIDs with full argv and inspect
   the expected port with process identities:

   ```bash
   ssh root@<ip> 'ps -ww -eo pid=,args='
   ssh root@<ip> 'ss -ltnp "sport = :<exact-port>"'
   ssh root@<ip> 'readlink -- /proc/<candidate-pid>/cwd'
   ```

   Record PID and full argv for every plausible candidate, including an
   unexpected systemd PID or a process naming the installed Saivage entry
   point. Inspect `/proc/<pid>/cwd` wherever it exists and whenever cwd is
   needed to establish the implicit project root. Conclusively bind every
   candidate and every listener PID/argv/cwd to this project, another known
   project, or a non-owner. A target-project owner forbids deletion. A process
   that disappears during inspection, unreadable cwd, truncated or ambiguous
   argv, unowned/unreadable listener, or any candidate that cannot be accounted
   for also stops recovery. Do not inspect process environments or
   secret-bearing unit environment.

   The unit/process/listener evidence never replaces CLI classification and
   never authorizes deletion by itself. Do not use broad kill patterns. If an
   actual surviving owner is identified, stop that exact process through its
   actual service or process authority, then restart this complete procedure at
   the stopped-unit step.

4. **Run only current CLI `status` from the exact project root.** Use the exact
   Node executable and CLI entry point resolved above. Keep stdout/stderr
   visible, preserve and print the remote exit status, and return that status.
   Do not use a pipeline, command substitution, `|| true`, or append deletion or
   startup:

   ```bash
   ssh root@<ip> 'cd -- "/exact/canonical-project-root" || exit; "/exact/node-executable" "/exact/current-cli-entry" status; status=$?; printf "CLI_EXIT_STATUS=%s\n" "$status"; exit "$status"'
   ```

5. **Apply the complete result table.** Inspect the exit status and the full
   output together; never infer dead ownership from one text fragment.

   | Current CLI observation | Required action |
   | --- | --- |
   | Exit 0 and exactly `Service: stopped (no live owner)`, `Runtime status: stopped`, and `Current card: (none)`, in that order, with no repair sentence | `missing`. Delete nothing. Continue only toward fresh no-owner reconfirmation and exact replacement-service startup. This authorizes no project Run. |
   | Exit 0 and those exact three lines followed by the exact canonical repair sentence below | Positive `dead` predicate only. Enter the manual-deletion branch only if the project-bound no-owner evidence is also fresh and conclusive. This authorizes no project Run. |
   | Exit 0 with delegated live-status JSON or any other live/delegation output | Never delete. The verified live owner remains authoritative. |
   | Nonzero labeled `Lifecycle lock indeterminate` or `Lifecycle lock malformed`, even when the error embeds repair text | Fail closed. Do not delete, start, or take over; resolve or escalate under canonical policy. |
   | Null-endpoint, auth, network, response, schema, or any other delegation failure | Never delete. Failure to control or contact a verified live authority is not death. |
   | Any other exit/output combination | Unmatched: stop. Do not delete, start, or reinterpret it. |

   The exact three stopped/no-live lines are:

   ```text
   Service: stopped (no live owner)
   Runtime status: stopped
   Current card: (none)
   ```

   The positive-dead repair sentence must exactly name the resolved canonical
   project root and canonical lock path:

   ```text
   Verify that no Saivage process owns '<canonical-project-root>', then remove the abandoned lock manually with: rm -- '<canonical-lock-path>'; rerun the command.
   ```

   The exact missing predicate is the same zero exit and three lines without
   that sentence. The repair sentence is not sufficient: fatal results labeled
   `Lifecycle lock malformed` or `Lifecycle lock indeterminate` also embed it
   but exit nonzero.

6. **For positive dead only, recollect evidence and manually repair.** Repeat
   the exact-unit `ActiveState`/`SubState`/`MainPID`, full candidate PID/argv/cwd,
   and process-bearing expected-listener checks immediately before deletion.
   Both gates—the exact CLI positive-dead predicate and fresh conclusive
   project-bound no-owner evidence—are mandatory; neither substitutes for the
   other. Any changed or inconclusive result stops recovery.

   After explicit operator authorization for abandoned-lock repair, execute
   only the CLI-displayed exact command as one standalone shell command:

   ```bash
   rm -- '<canonical-lock-path>'
   ```

   Do not use `-f`, a glob, an alternate or derived path, a sibling scan, a
   second deletion, or a chained command.

7. **Prove the repaired result is missing.** In a separate invocation, repeat
   the exact CLI `status` observation from step 4. Require exit 0 and exactly
   the three stopped/no-live lines, with no repair sentence. Every other result
   stops recovery. The original `missing` branch skips deletion and this
   repeated classification, but not final no-owner reconfirmation.

8. **Start and verify only the exact replacement service.** From either
   qualifying `missing` path, freshly reconfirm the stopped unit and conclusive
   absence of a project-bound process/listener. Start the exact unit as a
   separate action, inspect its state separately, and verify the matching exact
   health endpoint reaches ready health:

   ```bash
   ssh root@<ip> 'systemctl start <exact-unit>'
   ssh root@<ip> 'systemctl show <exact-unit> --property=ActiveState --property=SubState --property=MainPID --no-pager'
   curl -fsS http://<ip>:<exact-port>/health
   ```

   Startup strictly validates the whole generated card tree and may take
   minutes on a large bind-mounted project. After one valid start, allow that
   validation to finish before judging health; do not repeatedly restart merely
   because validation is slow. Mandatory recovery ends at healthy exact-service
   readiness. It restores only the server lifecycle and never authorizes
   project execution.

### Unexpected Surviving Instance Or Listener

A clean service exit after startup or `EADDRINUSE` is evidence to diagnose, not
proof of an abandoned lock. Keep manual foreground, PTY, or nohup
`saivage.js start` processes out of normal service operation. Do not kill all
matching processes or free a port broadly. Stop an identified survivor only
through its exact service/process authority. Then use the singular
[Lifecycle-Lock Classification And Manual Repair](#lifecycle-lock-classification-and-manual-repair)
sequence from its stopped-unit step; there is no second lock-removal path.

### Separately Authorized Ordinary Project Run

Do not submit `start_project` as part of lifecycle-lock or service recovery and
do not present it as the default next step. Outage history, dead classification,
manual deletion, replacement startup, a newly acquired lock, and healthy
service readiness confer no authority to execute the project; it may have been
intentionally stopped before the outage.

Only a current operator instruction or explicit incident-recovery objective can
independently authorize considering ordinary Run. At that later point, follow
the applicable canonical [runbook](../../../docs/runbook/index.md), including
the [trusted failed-root reopening and restart](../../../docs/runbook/index.md#trusted-failed-root-reopening-and-restart)
procedure when the root is failed. Establish the exact healthy lifecycle owner
and control authority, inspect current runtime status and strict current
card/root state, and require the current procedure's admission conditions. Do
not infer eligibility from preserved state, outage history, or server health.

If and only if those current checks admit the independently authorized action,
send a separate fresh current Analyst submission requiring exactly one bodyless
`start_project` call and final prose. Verify its exact settled tool result and
the canonical runtime/card/dispatch evidence required by that procedure. This
is a fresh ordinary Run that can perform full-chain stopped recovery, not
continuation of an old execution node and not CLI `resume`. Missing
authorization, an ineligible state, a failed check, or ambiguity means do not
submit `start_project`.

Keep these boundaries exact:

- `systemctl stop/start <exact-unit>` disposes or creates the server process and
  therefore the lifecycle owner.
- CLI `resume` delegates through a verified live owner to a paused project. It
  cannot recover a missing/dead owner and is not a post-restart action.
- CLI `stop` delegates to bodyless REST `stop_project`; there is no CLI
  `stop_project` alias. It halts project execution while leaving the server and
  lifecycle lock alive.
- Current Analyst `start_project` initiates ordinary Run only under the separate
  authorization and current-state checks above.
- Authenticated confirmed `restart_server` is a separate public server
  operation and is not part of dead-lock repair.

### Network-Outage Failed Cards

Transient host network loss can exhaust provider retries and leave the root card
failed with the runtime halted. First verify outbound connectivity. If the
diagnosed incident is eligible for ordinary reopen followed by a new Run, follow
the canonical [trusted failed-root reopening and restart](../../../docs/runbook/index.md#trusted-failed-root-reopening-and-restart)
procedure. Its prerequisites derive the configured root-process sessions plus
the configured global Analyst session; do not substitute default role names or
an LXC-local call sequence.

## SSH Repair Fallback

If `ssh root@<ip>` fails, use `lxc-attach` only to restore root's authorized keys
from the container user's existing keys. Do not read private keys or print key material.

```bash
CT=pueblicos  # or saivage-v3, saivage-v3-getrich-v2
sudo lxc-attach -n "$CT" -- sh -lc 'set -eu; mkdir -p /root/.ssh; chmod 700 /root/.ssh; touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; if [ -f /home/salva/.ssh/authorized_keys ]; then while IFS= read -r key; do [ -n "$key" ] || continue; grep -qxF "$key" /root/.ssh/authorized_keys || printf "%s\n" "$key" >> /root/.ssh/authorized_keys; done < /home/salva/.ssh/authorized_keys; fi; chown -R root:root /root/.ssh'
sudo lxc-attach -n "$CT" -- systemctl restart ssh.service
```

After several failed SSH attempts, OpenSSH may temporarily reject valid attempts.
Restarting `ssh.service` inside the container clears that penalty state.
