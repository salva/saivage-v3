---
name: saivage-lxc-operations
description: 'Operate local Saivage deployments in classic LXC containers. Use when checking Saivage health, inspecting or restarting saivage, saivage-v3, or saivage-v3-getrich-v2, verifying bind mounts, reading systemd units, or diagnosing container/runtime state in /home/salva/g/ml.'
---

# Saivage LXC Operations

## When to Use This Skill

Use this skill for local Saivage service operations involving classic LXC containers.

## Ground Rules

- Work from `/home/salva/g/ml` unless the task names another path.
- **Prefer passwordless SSH** for everything in-container. Both `root@<ip>` and `salva@<ip>` are configured for all three containers from the host's regular user account; SSH does NOT require `sudo` and does NOT prompt for a password.
- Use `root@<ip>` when the action needs privileges (systemctl, journalctl, writing under `/root` or `/etc`, restarting the SSH daemon). Use `salva@<ip>` for non-privileged inspection (curl, ps, cat of world-readable files).
- Fall back to classic LXC commands (`sudo lxc-ls --fancy`, `sudo lxc-info -n <name>`, `sudo lxc-attach -n <name> -- <command>`) ONLY for: container lifecycle (start/stop), repairing broken SSH access, reading the LXC config under `/var/lib/lxc/<name>/config`, or when the container has no IP yet.
- Do not use `lxc exec` or `lxc list`; this host uses classic LXC tooling.
- Secret-bearing files such as `.saivage/auth-profiles.json`, `.saivage/saivage.json`, env files, shell history, or token files may be inspected or edited when authorized or needed. Avoid unnecessary disclosure of secret values in chat or logs.
- Use `tmp/` under `/home/salva/g/ml` for temporary artifacts.

## Known Deployments

| Container | URL | Service | SSH (root) | SSH (salva) | Purpose |
| --- | --- | --- | --- | --- | --- |
| `saivage` | `http://10.0.3.111:8080/health` | deployment-specific v2 service | `root@10.0.3.111` | `salva@10.0.3.111` | Old Saivage v2 deployment working on GetRich. |
| `saivage-v3` | `http://10.0.3.112:8080/health` | `saivage.service` | `root@10.0.3.112` | `salva@10.0.3.112` | Dedicated Saivage v2 harness working on `/work/saivage-v3`. |
| `saivage-v3-getrich-v2` | `http://10.0.3.170:8080/health` | `saivage-v3-getrich.service` | `root@10.0.3.170` | `salva@10.0.3.170` | Saivage v3 deployment for GetRich v2. |

Verified 2026-05-20: root and salva SSH worked for all three containers from `/home/salva/g/ml` without `sudo` and without password. Host HTTP health probes failed or timed out on 2026-06-03, so re-verify container status/IPs before operational changes.

## Standard Workflow (SSH-first)

Use SSH for inspection and service control. `sudo lxc-attach` is the fallback only.

```bash
ssh root@10.0.3.111 'systemctl is-active saivage.service 2>/dev/null || ps -ef | grep -E "node|saivage" | grep -v grep'
ssh root@10.0.3.112 'systemctl is-active saivage.service'
ssh root@10.0.3.170 'systemctl is-active saivage-v3-getrich.service'
```

1. Probe health (no SSH needed; runs on the host):

```bash
curl -fsS http://10.0.3.111:8080/health || true
curl -fsS http://10.0.3.112:8080/health || true
curl -fsS http://10.0.3.170:8080/health || true
```

2. Inspect a service:

```bash
ssh root@10.0.3.112 'systemctl status saivage.service --no-pager | head -20'
ssh root@10.0.3.112 'journalctl -u saivage.service -n 120 --no-pager'
ssh root@10.0.3.170 'systemctl status saivage-v3-getrich.service --no-pager | head -20'
```

3. Restart only the intended service:

```bash
ssh root@10.0.3.112 'systemctl restart saivage.service && systemctl is-active saivage.service'
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
```

4. Verify live container IPs (use only when SSH/health is failing):

```bash
sudo lxc-ls --fancy
sudo lxc-info -n saivage-v3
sudo lxc-info -n saivage-v3-getrich-v2
```

## SSH Repair (fallback when root SSH is broken)

If `ssh root@<ip>` fails, copy `salva`'s already-authorized public keys into root's `authorized_keys` via `lxc-attach`. Do not print key material or read private keys.

```bash
CT=saivage  # or saivage-v3, saivage-v3-getrich-v2
sudo lxc-attach -n "$CT" -- sh -lc 'set -eu; mkdir -p /root/.ssh; chmod 700 /root/.ssh; touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; if [ -f /home/salva/.ssh/authorized_keys ]; then while IFS= read -r key; do [ -n "$key" ] || continue; grep -qxF "$key" /root/.ssh/authorized_keys || printf "%s\n" "$key" >> /root/.ssh/authorized_keys; done < /home/salva/.ssh/authorized_keys; fi; chown -R root:root /root/.ssh'
sudo lxc-attach -n "$CT" -- systemctl restart ssh.service
```

After several failed SSH attempts, OpenSSH may log `penalty: failed authentication` and reject even valid attempts. Restarting `ssh.service` inside the container clears that penalty state.

## Important Notes

- `saivage-v3` is a separate v2 harness for the Saivage v3 target project. Do not place warnings about the old GetRich v2 instance into that target project's objectives or planner instructions.
- `saivage-v3-getrich-v2` bind mounts `/home/salva/g/ml/saivage-v3` at `/opt/saivage-v3` and `/home/salva/g/ml/getrich-v2` at `/work/getrich-v2`.
- After changing Saivage v3 code for the bind-mounted deployment, run `npm run build` in `/home/salva/g/ml/saivage-v3` before restarting `saivage-v3-getrich.service`.
- Root SSH on `saivage-v3` has been verified with `root@10.0.3.112`; if host public key files are unreadable because of local permissions, use the container user's existing `/home/salva/.ssh/authorized_keys` via `lxc-attach` instead of changing private-key files casually.
