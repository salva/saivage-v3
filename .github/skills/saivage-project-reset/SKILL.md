---
name: saivage-project-reset
description: 'Reset a target project managed by a Saivage v3 deployment, such as GetRich v2 or Pueblicos, to a clean local runtime while preserving model configuration, credentials, and source spec documents. Use when asked to reset a Saivage v3-managed project, clean that target project .saivage state, rebuild cards from SPEC/PLAN docs, preserve provider credentials, or start a target project from a pristine .saivage environment.'
---

# Saivage v3 Target Project Reset

Use this skill for target projects managed by a Saivage v3 runtime deployment,
especially `/home/salva/g/ml/getrich-v2` and `/home/salva/g/ml/pueblicos`.
The Saivage v3 implementation repo (`/home/salva/g/ml/saivage-v3`) supplies the
runtime/build used to recreate target-project state; it is not the reset target.

## Do Not Use For

- Resetting the Saivage v3 source repository itself.
- Cleaning OpenCode sessions, OpenCode config, `.opencode/`, or agent tooling state.
- Resetting older Saivage v2-managed projects unless the user explicitly asks to port the workflow.
- Deleting target project source files that are not generated Saivage runtime state.

## Safety Rules

- Stop the relevant Saivage v3 service before modifying a target project's `.saivage/` or `.saivage-work/`.
- Preserve only model/provider configuration, credentials, and explicit source documents such as `docs/SPEC.md` and `docs/PLAN.md`; inspect or edit secrets when authorized or needed, but do not print them.
- Do not preserve generated cards, runtime state, old planner outputs, or stale project objectives as authoritative reset input.
- Do not store Saivage state in `~/.saivage`.
- Keep backup artifacts under `/home/salva/g/ml/tmp/`.
- Do not put reset notes into the target project's `.saivage/notes` or `.saivage/instructions`.
- Build or verify the Saivage v3 source tree before using `dist/` helpers if the reset depends on freshly changed runtime code.

## Known Saivage v3 Targets

- GetRich v2 deployment: host project `/home/salva/g/ml/getrich-v2`, container `saivage-v3-getrich-v2`, service `saivage-v3-getrich.service`, health `http://10.0.3.170:8080/health`.
- Pueblicos deployment: host project `/home/salva/g/ml/pueblicos`, container `pueblicos`, service `saivage-pueblicos.service`, health `http://10.0.3.52:8080/health`.
- For any other target, verify the bind mount, service name, target path, and API auth mode before making changes.

## Files To Preserve

Preserve these files when present in the target project:

- `.saivage/saivage.json`
- `.saivage/auth-profiles.json`
- User-named source documents, commonly `docs/SPEC.md` and `docs/PLAN.md`
- Any project source files outside generated `.saivage/` and `.saivage-work/`

Do not preserve these as authoritative reset input:

- `.saivage/runtime/`
- `.saivage/stages/`
- `.saivage/cards/` or generated card stores
- `.saivage-work/tmp/`
- Old planner/executor outputs, transcripts, locks, process output, or card-derived objectives

## Reset Workflow For GetRich v2

Use passwordless SSH (`root@10.0.3.170`) for service control; `sudo lxc-attach` is fallback only.

1. Verify bind mounts and service target:

```bash
sudo lxc-info -n saivage-v3-getrich-v2
sudo sed -n '1,220p' /var/lib/lxc/saivage-v3-getrich-v2/config | rg 'lxc.mount.entry|saivage-v3|getrich-v2'
```

2. Stop the service:

```bash
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service'
```

3. From `/home/salva/g/ml/getrich-v2`, copy credential-bearing files and source spec documents into `tmp/` paths. Inspect or edit secrets when authorized or needed.

4. Move old `.saivage/` and `.saivage-work/` into a timestamped backup under `/home/salva/g/ml/tmp/`.

5. Recreate the Saivage tree using the Saivage v3 build:

```bash
cd /home/salva/g/ml/saivage-v3
node --input-type=module -e 'import { initProjectTree } from "./dist/src/utils/file-tree.js"; initProjectTree("/home/salva/g/ml/getrich-v2");'
```

6. Restore `.saivage/saivage.json` and `.saivage/auth-profiles.json`.

7. Restart the service, then ask the canonical analyst to create the project card from the preserved spec documents and start the process. Use the analyst route/control surface instead of manually creating project/backlog cards.

8. Verify:

```bash
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

## Reset Workflow For Pueblicos

Use passwordless SSH (`root@10.0.3.52`) for service control; `sudo lxc-attach` is fallback only.

1. Verify bind mounts and service target:

```bash
sudo lxc-info -n pueblicos
sudo sed -n '1,220p' /var/lib/lxc/pueblicos/config | rg 'lxc.mount.entry|saivage-v3|pueblicos'
```

2. Stop the service:

```bash
ssh root@10.0.3.52 'systemctl stop saivage-pueblicos.service'
```

3. From `/home/salva/g/ml/pueblicos`, copy preserved config/credentials and source spec documents into a timestamped backup under `/home/salva/g/ml/tmp/`. This deployment intentionally may run without `SAIVAGE_API_TOKEN`; preserve that auth-mode choice instead of inventing credentials.

4. Move generated `.saivage/` and `.saivage-work/` into the same timestamped backup.

5. Recreate the Saivage tree using the Saivage v3 build:

```bash
cd /home/salva/g/ml/saivage-v3
node --input-type=module -e 'import { initProjectTree } from "./dist/src/utils/file-tree.js"; initProjectTree("/home/salva/g/ml/pueblicos");'
```

6. Restore preserved `.saivage/saivage.json`, `.saivage/auth-profiles.json` if present, and source spec documents.

7. Restart the service, then ask the analyst/control surface to recreate the project card from the preserved source documents and start the process.

8. Verify:

```bash
ssh root@10.0.3.52 'systemctl start saivage-pueblicos.service && systemctl is-active saivage-pueblicos.service'
curl -fsS http://10.0.3.52:8080/health
```

## Adapting To Other Saivage v3 Targets

1. Identify the host project path and service owner from current workspace handoff notes or by inspecting the container.
2. Stop only the matching service; do not stop unrelated Saivage deployments.
3. Preserve `.saivage/saivage.json`, `.saivage/auth-profiles.json` if present, and the source documents the user named as authoritative.
4. Move generated `.saivage/` and `.saivage-work/` state into a timestamped backup under `/home/salva/g/ml/tmp/`.
5. Recreate the project-local runtime tree with `initProjectTree(<target-path>)` from this repo's built `dist/` output.
6. Restore preserved config, credentials, and source documents.
7. Restart the service and verify `/health` plus any authenticated readiness/API checks required for that deployment.

## Objective Handling

After reset, objectives should be recreated by the analyst from the preserved spec documents, not copied from old card/runtime state. Ask the analyst to:

1. Read the preserved `docs/SPEC.md` and `docs/PLAN.md` or the user-specified source docs.
2. Create the root project card pointing at those documents as the source of truth.
3. Start the project process through the normal runtime control path.

Keep any operator reminders outside the target project's `.saivage/notes`, `.saivage/instructions`, and card objectives.
