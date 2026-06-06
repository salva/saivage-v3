import { CardStore } from '../../src/cards/card-store.js';

export function materializeProjectCard(projectRoot: string): void {
  const store = new CardStore(projectRoot);
  if (store.read('project')) return;
  store.create({
    type: 'project',
    parent: null,
    depth: 0,
    title: 'Project',
    description: 'Test project root',
    status: 'backlog',
    depends_on: [],
    priority: 0,
    tags: [],
    urgency: 'normal',
    created_by: 'analyst',
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}
