---
name: saivage-v2-on-v3-control
description: 'Operate the dedicated Saivage v2 harness that works on the Saivage v3 target project. Use when inspecting /work/saivage-v3 stage state, v2 harness runtime routing, active plan/history, runtime-state, or service status in the saivage-v3 LXC container.'
---

# Saivage v2 Harness On v3

## Purpose

The `saivage-v3` LXC container runs the Saivage v2 harness against the Saivage v3 project. This is the isolated v2-working-on-v3 environment.

## Environment

- Host v2 harness repo: `/home/salva/g/ml/saivage`
- Host target project: `/home/salva/g/ml/saivage-v3`
- Container target path: `/work/saivage-v3`
- Container service: `saivage.service`
- Service command shape: `node dist/cli.js serve /work/saivage-v3`
- Health URL: `http://10.0.3.112:8080/health`

Because containers have separate IPs, this service uses port `8080` inside the `saivage-v3` container. Do not change it to `8081` just to avoid host-level port confusion.

## Current Runtime State Files

Under `/home/salva/g/ml/saivage-v3/.saivage/`:

- `saivage.json`: v2 harness runtime config for provider/model routing and service behavior; inspect or edit provider details when authorized or needed.
- `config.json`: Saivage v3 project objectives only. Do not put v2 harness provider/model routing here.
- `plan.json`: active staged plan. Stages require `references: []` even when no documents are authoritative.
- `plan-history.json`: archived completed stages.
- `runtime/runtime-state.json`: current v2 runtime and active agent state.

## Safe Inspection

Prefer SSH (passwordless, no `sudo`). Use `root@10.0.3.112` for systemd/journal, `salva@10.0.3.112` for non-privileged inspection. `sudo lxc-attach` is fallback only.

```bash
curl -fsS http://10.0.3.112:8080/health
ssh root@10.0.3.112 'systemctl status saivage.service --no-pager | head -20'
ssh root@10.0.3.112 'journalctl -u saivage.service -n 120 --no-pager'
ssh salva@10.0.3.112 'ps -ef | grep -E "node|saivage" | grep -v grep'
```

Secret-bearing files such as `.saivage/saivage.json`, auth profiles, provider configs, or environment files may be inspected or edited when authorized or needed. Avoid unnecessary disclosure of secret values in chat or logs.

If root SSH ever breaks, see the SSH Repair section of the `saivage-lxc-operations` skill for the `lxc-attach` recovery recipe.

## Service Control

```bash
ssh root@10.0.3.112 'systemctl restart saivage.service && systemctl is-active saivage.service'
curl -fsS http://10.0.3.112:8080/health
```

## Current Objective Boundary

The v2-on-v3 harness is focused on the Saivage v3 planner-control redesign: durable top-level planner control through explicit MCP-style planning and dispatch tools. Do not cite old v3 specs or historical implementation plans as authoritative during this recovery cycle unless the current source and user instructions validate them.

Keep a clear boundary between harness configuration and target project planning:

- Saivage v2 harness functionality/configuration: agent roles, model routing, providers, service port, and LXC controls.
- Saivage v3 project planning: target project objectives, stages, acceptance criteria, design/implementation tasks, and artifacts.

Provider and model choices are harness runtime configuration. They should not appear as Saivage v3 project objectives or stage acceptance criteria unless the stage is explicitly about routing functionality.

Operational warnings about the old `saivage` GetRich instance belong in workspace handoff guidance, not in the `saivage-v3` target project's objectives, notes, or planner instructions.
