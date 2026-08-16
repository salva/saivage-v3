import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';

import type { Environment } from '../config/index.js';
import { publishInitialProjectCard, type InitialProjectCardInput } from '../persistence/card-files.js';
import { initializeConversation } from '../persistence/conversation-file.js';
import { saivageCardsRoot } from '../persistence/layout.js';
import { globalAgentSessionId } from '../schemas/index.js';

function newProjectRootInput(projectRoot: string): InitialProjectCardInput {
  const title = basename(projectRoot) || 'saivage-project';
  return { title, bootstrap_content: `# Goal\n\nDefine and execute the ${title} project.\n\n# Instructions\n\nUse this root card as the canonical project objective and planning anchor.\n\n# Acceptance Criteria\n\n- The project objective is captured in the root card bootstrap record.\n- Child work is created under this project card.\n` };
}

export function publishInitialProjectRuntime(projectRoot: string, workflows: Environment['workflows']): void {
  mkdirSync(saivageCardsRoot(projectRoot), { recursive: true });
  publishInitialProjectCard(projectRoot, newProjectRootInput(projectRoot), workflows.cardTypes.get('project')!);
  initializeConversation(projectRoot, globalAgentSessionId(workflows.analyst.name));
}
