---
name: saivage-getrich-v2-spec-plan-reset
description: Use when resetting the saivage-v3-getrich-v2 instance so GetRich v2 keeps only docs/SPEC.md, docs/PLAN.md, Saivage model config, and credentials before restarting the service.
---

# Saivage GetRich V2 SPEC/PLAN Reset

Use this skill only for the `saivage-v3-getrich-v2` deployment that runs Saivage v3 against `/home/salva/g/ml/getrich-v2`, mounted in the container as `/work/getrich-v2`.

## Preserve Exactly

- `/home/salva/g/ml/getrich-v2/docs/SPEC.md`
- `/home/salva/g/ml/getrich-v2/docs/PLAN.md`
- `/home/salva/g/ml/getrich-v2/.saivage/saivage.yaml`
- `/home/salva/g/ml/getrich-v2/.saivage/auth-profiles.json`

Do not print secrets or provider configuration values from `saivage.yaml` or `auth-profiles.json` in chat or logs.

## Reset Workflow

1. Verify the service target.

```bash
ssh root@10.0.3.170 'systemctl is-active saivage-v3-getrich.service; systemctl show -p WorkingDirectory -p ExecStart saivage-v3-getrich.service'
```

2. Stop the service before editing the target tree.

```bash
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service || true'
```

3. Create a timestamped backup under workspace `tmp/`, then copy the four preserved files into a `preserve/` subdirectory.

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
root=/home/salva/g/ml/getrich-v2
backup=/home/salva/g/ml/tmp/getrich-v2-spec-plan-config-reset-${ts}
preserve=${backup}/preserve
mkdir -p "${backup}/full" "${preserve}/docs" "${preserve}/.saivage"
cp -a "${root}/." "${backup}/full/"
cp -a "${root}/docs/SPEC.md" "${preserve}/docs/SPEC.md"
cp -a "${root}/docs/PLAN.md" "${preserve}/docs/PLAN.md"
cp -a "${root}/.saivage/saivage.yaml" "${preserve}/.saivage/saivage.yaml"
cp -a "${root}/.saivage/auth-profiles.json" "${preserve}/.saivage/auth-profiles.json"
printf '%s\n' "${backup}" > /home/salva/g/ml/tmp/getrich-v2-latest-spec-plan-config-reset.txt
```

4. Wipe the target project contents and restore only `docs/SPEC.md` and `docs/PLAN.md`.

```bash
rm -rf "${root}"/* "${root}"/.[!.]* "${root}"/..?*
mkdir -p "${root}/docs"
cp -a "${preserve}/docs/SPEC.md" "${root}/docs/SPEC.md"
cp -a "${preserve}/docs/PLAN.md" "${root}/docs/PLAN.md"
```

5. Recreate a clean Saivage runtime skeleton from the built Saivage v3 tree, then restore model config and credentials over the defaults.

```bash
node --input-type=module -e 'import { initProjectTree } from "/home/salva/g/ml/saivage-v3/dist/src/persistence/file-tree.js"; initProjectTree("/home/salva/g/ml/getrich-v2");'
cp -a "${preserve}/.saivage/saivage.yaml" "${root}/.saivage/saivage.yaml"
cp -a "${preserve}/.saivage/auth-profiles.json" "${root}/.saivage/auth-profiles.json"
```

6. Verify the resulting top-level layout.

Expected top-level entries:

```text
.saivage/work/
.saivage/
docs/
```

Expected docs entries:

```text
PLAN.md
SPEC.md
```

7. Restart and verify health.

```bash
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/health/ready
```

## Notes

- The target project is not a Git repository, so the backup under `tmp/` is the recovery point.
- The reset intentionally deletes generated cards, runtime state, tests, outputs, Python packages, and all docs except `SPEC.md` and `PLAN.md`.
- The clean `.saivage/` and `.saivage/work/` skeletons are allowed because the service needs them to boot, but persisted model routing and credentials must come from the preserved files.
