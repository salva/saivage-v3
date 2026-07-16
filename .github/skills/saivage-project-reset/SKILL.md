---
name: saivage-project-reset
description: 'Reset a target project managed by a Saivage v3 deployment, such as GetRich v2 or Pueblicos, to a clean local runtime while preserving Saivage configuration, credentials, operator state, and source/spec documents. Use when asked to reset a Saivage v3-managed project, clean generated .saivage state, preserve provider credentials, prompt overrides, skill indexes, instructions, or restart from the current empty layout.'
---

# Saivage v3 Target Project Reset

Use this skill for target projects managed by a Saivage v3 runtime deployment,
especially `/home/salva/g/ml/getrich-v2` and `/home/salva/g/ml/pueblicos`.
The Saivage v3 implementation repo (`/home/salva/g/ml/saivage-v3`) supplies the
runtime/build used to recreate target-project state; it is not the reset target.

## Safety Rules

- Stop the relevant Saivage v3 service before modifying a target project's runtime state.
- Do not manually wipe the whole `.saivage/` tree or compose reset from internal helpers. The built `saivage reset` command is the only reset entry point.
- Preserve durable project/security/operator inputs when present: `.saivage/saivage.yaml`, `.saivage/auth-profiles.json`, `.saivage/project.json`, `.saivage/config/prompts/`, `.saivage/skills/index.json`, `.saivage/instructions/`, and target source/spec docs such as `docs/SPEC.md` and `docs/PLAN.md`.
- Inspect or edit secrets when authorized or needed, but do not print token/provider/auth values.
- Do not restore content from the four reset-owned generated roots after reset.
- Do not store Saivage state in `~/.saivage`.
- Keep backup artifacts under `/home/salva/g/ml/tmp/`.
- Do not put new reset notes or operator reminders into the target project's `.saivage/instructions/`; existing `.saivage/instructions/` is durable operator state and must be preserved when applicable.
- Build or verify the Saivage v3 source tree before using `dist/` helpers if the reset depends on freshly changed runtime code.

## Current Reset Contract

Current `saivage reset` is an explicit generated-state reset. Its command-level direct
composition acquires one bound `.saivage/locks/runtime.lock`, deletes the four exact
reset-owned generated roots wholesale, and publishes a new root card through named
stateless synchronous file functions while retaining that exact lock.
Matching-owner release removes it only after the command finishes. Every
pre-existing exact canonical `runtime.lock` blocks reset, whether it describes a
live owner, appears dead or stale, or is malformed or unreadable; Saivage never
removes or takes it over automatically. After stopping the exact service, verify through service,
process, and target-path inspection that no Saivage process owns the canonical
project. Only then remove the exact displayed lock path explicitly with
`rm -- '<absolute-runtime-lock-path>'` and rerun reset.

Generated roots removed by reset:

- `.saivage/cards/`
- `.saivage/agents/`
- `.saivage/logs/`
- `.saivage/work/`

Each root is passed directly to recursive forced whole-tree removal without probing or
enumerating descendants. Every path outside those four exact roots is preserved. The
`.saivage/locks/` namespace is only the lifecycle safety boundary: reset never discovers,
classifies, or cleans arbitrary lock siblings and exact-owner release removes only the
command's `runtime.lock`.

Successful reset postcondition:

- Preserved durable inputs still exist, including prompt overrides, skills, instructions, project identity, config, credentials, and source/spec docs.
- `.saivage/cards/project/` exists as the canonical root project card.
- `.saivage/agents/`, `.saivage/logs/`, and `.saivage/work/` remain absent until a current owner creates them.
- `.saivage/locks/runtime.lock` is absent after release; any arbitrary lock siblings are untouched.
- Every path outside the four reset-owned roots retains its prior contents.

## Known Saivage v3 Targets

- GetRich v2 deployment: host project `/home/salva/g/ml/getrich-v2`, container `saivage-v3-getrich-v2`, service `saivage-v3-getrich.service`, health `http://10.0.3.170:8080/health`.
- Pueblicos deployment: host project `/home/salva/g/ml/pueblicos`, container `pueblicos`, service `saivage-pueblicos.service`, health `http://10.0.3.52:8080/health`.
- For any other target, verify the bind mount, service name, target path, and API auth mode before making changes.

## Reset Workflow

1. Verify the target service and bind mount.
2. Stop only the matching service; do not stop unrelated Saivage deployments.
3. Back up the full target project under `/home/salva/g/ml/tmp/` before pruning or resetting.
4. Preserve the durable inputs listed above. For source-scope resets such as GetRich v2, prune source files only according to the user-approved source reset scope, then restore the preserved source/spec docs.
5. From the target project directory, run the current built CLI reset when available:

```bash
cd /path/to/target-project
/home/salva/g/ml/saivage-v3/bin/saivage.js reset
```

6. Verify the reset postcondition above before restarting the service.
   Do not restore old bare-row JSONL, runtime state, snapshots, provider availability,
   conversation versions, summary caches, or index authority. Stable conversations and the app
   log use the current strict envelope format, and durable-format cutovers are reset-only.
7. Restart the service and verify `/health` plus any authenticated readiness/API checks required for that deployment.
8. Ask the analyst/control surface to derive new objectives from preserved source/spec documents. Do not copy old card/runtime state back in.

## Target-Specific Service Commands

GetRich v2:

```bash
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service'
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

Pueblicos:

```bash
ssh root@10.0.3.52 'systemctl stop saivage-pueblicos.service'
ssh root@10.0.3.52 'systemctl start saivage-pueblicos.service && systemctl is-active saivage-pueblicos.service'
curl -fsS http://10.0.3.52:8080/health
```
