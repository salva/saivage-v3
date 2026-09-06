---
name: saivage-lxc-operations
description: 'Operate local LXC deployments that matter to Saivage v3: the v2-on-v3 harness, Saivage v3 running against GetRich v2, Pueblicos, and jsqlite. Use when checking Saivage v3 deployment health, inspecting/restarting those services, verifying bind mounts, reading systemd units, diagnosing target-project runtime state, confirming container IPs, or recovering instances after host power loss, hard reboots, abandoned runtime.lock crash loops, or network-outage failed cards.'
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

## Power-Outage / Hard-Reboot Recovery

After the host loses power or is hard-rebooted (battery drain, crash), the
containers autostart but the in-container Saivage services crash-loop with:

```text
Fatal error: Runtime lock owner is positively dead. Verify that no Saivage
process owns '<project>', then remove the abandoned lock manually with:
rm -- '<project>/.saivage/locks/runtime.lock'; rerun the command.
```

Recovery per instance (pueblicos shown; jsqlite uses service
`saivage-jsqlite.service`, project `/work/jsqlite`, port 8081):

1. Resolve current container IPs first (they change across reboots):

```bash
ssh root@localhost 'lxc-ls --fancy'
```

2. Stop the crash-looping service, verify no Saivage process remains, remove
the exact abandoned lock path, and start exactly one instance via systemd:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@<ip> '
  systemctl stop saivage-pueblicos.service
  ps aux | grep -E "saivage" | grep -v grep || echo NO_PROCESS
  rm -f -- /work/pueblicos/.saivage/locks/runtime.lock
  systemctl start saivage-pueblicos.service
  systemctl is-active saivage-pueblicos.service'
```

3. Wait patiently for health. Startup validates the whole card tree on the
bind-mounted host disk: ~100-150s for pueblicos (~970+ cards) and ~120-150s for
jsqlite (~1500+ cards). Poll every 5s; do not restart during validation.

4. After health returns OK, the runtime sits idle in `stopped` by design.
Restart autonomous work through the analyst chat (auth is disabled on both
instances):

```bash
node -e "
(async()=>{
  const r=await fetch('http://<ip>:<port>/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({content:'The host lost power; the service just restarted cleanly from the preserved state. Please start the project now (start_project) and resume autonomous work from where it stood.'})});
  console.log(r.status, (await r.text()).slice(0,180));
})()"
```

5. Confirm dispatch via `/api/runtime/status` (`runtime: running` with active
cards) and a fresh provider exchange in the project's
`.saivage/logs/app.jsonl`.

### Orphaned-Instance Port/Lock Races

Symptom: the service starts, consumes ~2min CPU, then exits cleanly (exit 0,
`Deactivated successfully`) with zero output, or dies with
`EADDRINUSE 0.0.0.0:8080`. Cause: overlapping orphaned server instances from
manual foreground/PTY/nohup diagnostic runs still hold the port or recreate the
lock while systemd's instance boots.

Rules:

- Never leave manual `saivage.js start` processes running; always run the
  service through its systemd unit.
- Before starting the unit, kill every stray instance and free the port:

```bash
ssh root@<ip> 'pkill -f "saivage.js start"; sleep 3; pgrep -fa "saivage.js" || echo CLEAN; ss -ltn | grep -E ":8080|:8081" || echo PORTS_FREE; rm -f -- /work/<project>/.saivage/locks/runtime.lock'
```

- Beware `pkill -f "port 8080"`: the pattern matches the invoking wrapper shell
  and kills your own SSH command. Match on `saivage.js start` instead.

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
