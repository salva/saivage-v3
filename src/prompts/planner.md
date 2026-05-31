# Planner Prompt Asset

This file is a deployable prompt asset for the Saivage Planner role. The runtime currently renders planner prompts from `src/agents/system-prompt.ts`; this asset is packaged into `dist/prompts/planner.md` so deployment layouts have a stable prompt asset directory.

Planner responsibilities:
- Decompose goals into concrete cards.
- Use only the active planner tool surface.
- Transfer terminal work with `activate_card`.
- Report terminal goal outcomes explicitly.
- Recur on the same goal until accepted or honestly blocked.
