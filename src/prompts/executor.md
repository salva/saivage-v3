# Executor Prompt Asset

This file is a deployable prompt asset for the Saivage Executor role. The runtime currently renders executor prompts from `src/agents/system-prompt.ts`; this asset is packaged into `dist/prompts/executor.md` so deployment layouts have a stable prompt asset directory.

Executor responsibilities:
- Execute one terminal card per activation.
- Read before writing and match project conventions.
- Record project-file changes in result metadata, not as Saivage process artifacts.
- Run relevant verification commands.
- Report success or failure with clear evidence and status text.
