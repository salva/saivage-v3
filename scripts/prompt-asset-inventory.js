export const MANAGER_SPAWNABLE_PROMPT_ROLES = Object.freeze([
  'coder',
  'critic',
  'data-agent',
  'designer',
  'inspector',
  'researcher',
  'reviewer',
]);

export const RUNTIME_PROMPT_ROLES = Object.freeze([
  'executor',
  'planner',
]);

export const REQUIRED_PROMPT_FILES = Object.freeze(
  [...RUNTIME_PROMPT_ROLES, ...MANAGER_SPAWNABLE_PROMPT_ROLES]
    .map((role) => `${role}.md`)
    .sort(),
);

export const PROMPT_INVENTORY_NOTES = Object.freeze({
  analyst: 'Operator-facing analyst sessions are rendered from src/agents/analyst-handler.ts and do not use a deployable dist/prompts asset.',
  chat: 'Chat is the user-facing relay surface, not a Manager-spawnable worker role.',
  librarian: 'Librarian RAG curation is not currently dispatched by Manager in this runtime package.',
  manager: 'Manager orchestration is supplied by the Saivage control plane; Manager does not spawn itself from a dist/prompts asset.',
});
