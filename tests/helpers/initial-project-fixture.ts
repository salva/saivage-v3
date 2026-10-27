import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { prepareInitialProjectDirectories, publishInitialProjectCard } from '../../src/persistence/card-files.js';
import { initializeConversation } from '../../src/persistence/conversation-file.js';
import { saivageCardsRoot } from '../../src/persistence/layout.js';
import { globalAgentSessionId } from '../../src/schemas/index.js';
import type { CompiledProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';

/** Synthetic retained-state setup only; does not qualify native commissioning. */
export function publishTestProjectRuntime(projectRoot: string, workflows: CompiledProjectWorkflows): void {
  mkdirSync(saivageCardsRoot(projectRoot), { recursive: true });
  const workflow = workflows.cardTypes.get('project')!;
  prepareInitialProjectDirectories(projectRoot, workflow);
  initializeConversation(projectRoot, globalAgentSessionId(workflows.analyst.name));
  const title = basename(projectRoot) || 'saivage-project';
  publishInitialProjectCard(projectRoot, { title,
    bootstrap_content: `# Goal\n\nDefine and execute the ${title} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card bootstrap record.\n- Child work is created under this project card.\n`,
  }, workflow, null);
}
