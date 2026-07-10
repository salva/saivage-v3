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
- Do not manually wipe the whole `.saivage/` tree. Use the current locked reset/init semantics: acquire `.saivage/locks/runtime.lock`, delete only generated roots and known generated legacy roots, call `initProjectTree`, then release the lock.
- Preserve durable project/security/operator inputs when present: `.saivage/saivage.yaml`, `.saivage/auth-profiles.json`, `.saivage/project.json`, `.saivage/config/prompts/`, `.saivage/skills/index.json`, `.saivage/instructions/`, and target source/spec docs such as `docs/SPEC.md` and `docs/PLAN.md`.
- Inspect or edit secrets when authorized or needed, but do not print token/provider/auth values.
- Do not preserve generated cards, runtime state, stages, process output, app logs, locks, or old planner outputs as authoritative reset input.
- Do not store Saivage state in `~/.saivage`.
- Keep backup artifacts under `/home/salva/g/ml/tmp/`.
- Do not put new reset notes or operator reminders into the target project's `.saivage/instructions/`; existing `.saivage/instructions/` is durable operator state and must be preserved when applicable.
- Build or verify the Saivage v3 source tree before using `dist/` helpers if the reset depends on freshly changed runtime code.

## Current Reset Contract

Current `saivage reset` is a local runtime-state reset. It atomically acquires
`.saivage/locks/runtime.lock`, refuses without mutation while a live runtime owns
that lock, deletes generated roots, reinitializes the current empty layout/root
project card while still holding the lock, then releases it. A valid readable
lock is held when its validated payload names a live PID; lock age never expires
that lock. Malformed-content locks and valid locks with dead PIDs are removable
through the lock acquisition/stale-cleanup path. Existing lock files that cannot
be read fail closed: reset must not delete state or unlink the lock when lock
ownership is unknown.

Generated roots removed by reset:

- `.saivage/cards/`
- `.saivage/agents/`
- `.saivage/state/`
- `.saivage/logs/`
- `.saivage/locks/` contents other than the held `runtime.lock` during reset
- `.saivage/work/`
- `.saivage/stages/` when present
- `.saivage-work/`

Obsolete old roots may be cleaned when present, but are not current state:
`.saivage/runtime/`, `.saivage/tmp/`, `.saivage/archive/`,
`.saivage/supervision/`, `.saivage/notes/`, `.saivage/outputs/`, and
`.saivage/views/`.

Successful reset postcondition:

- Preserved durable inputs still exist, including prompt overrides, skills, instructions, project identity, config, credentials, and source/spec docs.
- `.saivage/cards/project/` exists as the canonical root project card.
- `.saivage/state/runtime.json` exists with default runtime state.
- `.saivage/logs/app.jsonl` exists and is empty.
- `.saivage/locks/` exists and `.saivage/locks/runtime.lock` is absent after release.
- `.saivage/work/cards/`, `.saivage/work/processes/`, and `.saivage/work/tmp/stash/` exist; removed work subdirs such as `tmp/runtime`, `tmp/uploads`, `tmp/previews`, `downloads`, and `quarantine` do not.

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

If using a built helper directly, it must implement the same locked sequence:
`acquireLock(projectRoot)` -> delete generated roots while preserving the held
`runtime.lock` -> `initProjectTree(projectRoot)` -> `releaseLock(projectRoot)`.

6. Verify the reset postcondition above before restarting the service.
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
