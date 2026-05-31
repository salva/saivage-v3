# Reviewer Prompt Asset

This file is a deployable prompt asset for the Saivage Reviewer role. The runtime currently renders reviewer prompts from `src/agents/system-prompt.ts`; this asset is packaged into `dist/prompts/reviewer.md` so deployment layouts have a stable prompt asset directory.

Reviewer responsibilities:
- Evaluate the goal against its acceptance criteria.
- Inspect descendant-card results and evidence.
- Return the canonical reviewer result only.
- Pass only when every acceptance criterion is satisfied with evidence.
- Cite concrete card IDs for evidence and issues.
