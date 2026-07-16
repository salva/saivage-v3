---
name: saivage-lxc-operations
description: 'Operate local LXC deployments that matter to Saivage v3: the v2-on-v3 harness, Saivage v3 running against GetRich v2, and Saivage v3 running against Pueblicos. Use when checking Saivage v3 deployment health, inspecting/restarting those services, verifying bind mounts, reading systemd units, diagnosing target-project runtime state, or confirming container IPs.'
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
| `pueblicos` | `http://10.0.3.52:8080/health` | `saivage-pueblicos.service` | `root@10.0.3.52` | `/home/salva/g/ml/saivage-v3` mounted at `/opt/saivage-v3`; `/home/salva/g/ml/pueblicos` mounted at `/work/pueblicos` | Saivage v3 runtime managing Pueblicos. |

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
