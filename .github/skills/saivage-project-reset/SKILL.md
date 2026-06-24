---
name: saivage-project-reset
description: 'Reset a Saivage-managed project to a clean local runtime while preserving credentials and current objectives. Use when asked to reset GetRich v2, clean Saivage state, rebuild cards, preserve provider credentials, or start from a pristine .saivage environment.'
---

# Saivage Project Reset

## Safety Rules

- Stop the relevant Saivage service before modifying `.saivage/` or `.saivage-work/`.
- Preserve `.saivage/saivage.json` and `.saivage/auth-profiles.json`; inspect or edit them when authorized or needed.
- Preserve objective text from current project cards or explicit user instructions.
- Do not store Saivage state in `~/.saivage`.
- Keep backup artifacts under `/home/salva/g/ml/tmp/`.
- Do not put reset notes into the target project's `.saivage/notes` or `.saivage/instructions`.

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

3. From `/home/salva/g/ml/getrich-v2`, copy credential-bearing files into `tmp/` paths. Inspect or edit them when authorized or needed.

4. Move old `.saivage/` and `.saivage-work/` into a timestamped backup under `/home/salva/g/ml/tmp/`.

5. Recreate the Saivage tree using the Saivage v3 build:

```bash
cd /home/salva/g/ml/saivage-v3
node --input-type=module -e 'import { initProjectTree } from "./dist/src/utils/file-tree.js"; initProjectTree("/home/salva/g/ml/getrich-v2");'
```

6. Restore `.saivage/saivage.json` and `.saivage/auth-profiles.json`.

7. Create backlog goal cards for the preserved objectives using `CardStore` from `dist/src/utils/card-store.js`.

8. Restart and verify:

```bash
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
```

## Objective Handling

When preserving objectives, keep wording focused on the current work, data assumptions, workflow, and acceptance criteria. Avoid adding workspace-control reminders to project objectives.
