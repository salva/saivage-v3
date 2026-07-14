---
name: saivage-getrich-v2-spec-plan-reset
description: Use when resetting the saivage-v3-getrich-v2 instance so GetRich v2 keeps docs/SPEC.md, docs/PLAN.md, Saivage config/credentials, project identity, prompt overrides, skills, and instructions when present before restarting the service.
---

# Saivage GetRich V2 SPEC/PLAN Reset

Use this skill only for the `saivage-v3-getrich-v2` deployment that runs
Saivage v3 against `/home/salva/g/ml/getrich-v2`, mounted in the container as
`/work/getrich-v2`.

## Preserve

Always preserve these source documents:

- `/home/salva/g/ml/getrich-v2/docs/SPEC.md`
- `/home/salva/g/ml/getrich-v2/docs/PLAN.md`

Preserve these Saivage durable inputs when present:

- `/home/salva/g/ml/getrich-v2/.saivage/saivage.yaml`
- `/home/salva/g/ml/getrich-v2/.saivage/auth-profiles.json`
- `/home/salva/g/ml/getrich-v2/.saivage/project.json`
- `/home/salva/g/ml/getrich-v2/.saivage/config/prompts/`
- `/home/salva/g/ml/getrich-v2/.saivage/skills/index.json`
- `/home/salva/g/ml/getrich-v2/.saivage/instructions/`

Do not print secrets or provider configuration values from preserved Saivage
configuration or auth files in chat or logs. Do not add reset notes to
`.saivage/instructions/`; preserve existing instructions only.

## Reset Workflow

1. Verify the service target.

```bash
ssh root@10.0.3.170 'systemctl is-active saivage-v3-getrich.service; systemctl show -p WorkingDirectory -p ExecStart saivage-v3-getrich.service'
```

2. Stop the service before editing the target tree.

```bash
ssh root@10.0.3.170 'systemctl stop saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service || true'
```

After stop, inspect the service, processes, bind-mounted target path, and
`/home/salva/g/ml/getrich-v2/.saivage/locks/runtime.lock`. Every existing lock
blocks reset, including a dead/stale-looking or malformed/unreadable record.
Saivage never removes it automatically. Only after verifying that no Saivage
process owns this canonical project may the operator explicitly remove that
exact path with `rm -- '/home/salva/g/ml/getrich-v2/.saivage/locks/runtime.lock'`
and rerun the command.

3. Create a timestamped full backup under workspace `tmp/`, then copy preserved
source docs and Saivage durable inputs into a `preserve/` subdirectory.

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
root=/home/salva/g/ml/getrich-v2
backup=/home/salva/g/ml/tmp/getrich-v2-spec-plan-config-reset-${ts}
preserve=${backup}/preserve
mkdir -p "${backup}/full" "${preserve}/docs" "${preserve}/.saivage"
cp -a "${root}/." "${backup}/full/"
cp -a "${root}/docs/SPEC.md" "${preserve}/docs/SPEC.md"
cp -a "${root}/docs/PLAN.md" "${preserve}/docs/PLAN.md"
for path in saivage.yaml auth-profiles.json project.json; do
  [ -e "${root}/.saivage/${path}" ] && cp -a "${root}/.saivage/${path}" "${preserve}/.saivage/${path}"
done
for path in config/prompts skills/index.json instructions; do
  if [ -e "${root}/.saivage/${path}" ]; then
    mkdir -p "${preserve}/.saivage/$(dirname "${path}")"
    cp -a "${root}/.saivage/${path}" "${preserve}/.saivage/${path}"
  fi
done
printf '%s\n' "${backup}" > /home/salva/g/ml/tmp/getrich-v2-latest-spec-plan-config-reset.txt
```

4. Prune the target source tree according to this GetRich-v2-specific reset
scope, then restore only the preserved source docs and Saivage durable inputs.
Do not recreate a manual `.saivage` skeleton; the current reset/init helper does
that under lock.

```bash
rm -rf "${root}"/* "${root}"/.[!.]* "${root}"/..?*
mkdir -p "${root}/docs" "${root}/.saivage"
cp -a "${preserve}/docs/SPEC.md" "${root}/docs/SPEC.md"
cp -a "${preserve}/docs/PLAN.md" "${root}/docs/PLAN.md"
cp -a "${preserve}/.saivage/." "${root}/.saivage/" 2>/dev/null || true
```

5. Invoke the current built CLI. This is the only reset entry point. Its bound
direct-command composition owns the strict lifecycle lock, command-scoped
persistence-health owner, generated-state deletion, and named synchronous store-backed
reinitialization until exact matching-owner release. It preserves
prompt overrides, skills, instructions, project identity, config, credentials,
and docs.

```bash
cd "${root}"
/home/salva/g/ml/saivage-v3/bin/saivage.js reset
```

6. Verify the resulting layout.

Current generated `.saivage` roots should include:

```text
.saivage/cards/project/
.saivage/agents/
.saivage/state/runtime.json
.saivage/logs/        # app.jsonl is absent until its first atomic envelope publication
.saivage/locks/        # exists, with no runtime.lock after reset returns
.saivage/work/cards/
.saivage/work/processes/
.saivage/work/tmp/stash/
docs/SPEC.md
docs/PLAN.md
```

Obsolete roots such as `.saivage/runtime/`, `.saivage/tmp/`,
`.saivage/archive/`, `.saivage/supervision/`, `.saivage/notes/`, and removed
work subdirs such as `.saivage/work/tmp/runtime/` must be absent unless they are
inside the external backup.

Do not copy old app-log, provider-availability, conversation-version,
summary-cache, or conversation-index files back after reset. Growing durable
files use strict version-1 row envelopes and the cutover is reset-only.

7. Restart and verify health.

```bash
ssh root@10.0.3.170 'systemctl start saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/health/ready
```

## Notes

- The target project is not a Git repository, so the backup under `tmp/` is the recovery point.
- The reset intentionally deletes generated cards, runtime state, app logs, locks, process output, stages, tests, outputs, Python packages, and all docs except `SPEC.md` and `PLAN.md`.
- The clean runtime layout is created by Saivage reset/init, not by a hand-written skeleton. Persisted model routing, credentials, project identity, prompt overrides, skills, and instructions must come from the preserved inputs when present.
