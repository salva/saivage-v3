import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_project_files', call: callPresenters.list_project_files, result: resultPresenters.list_project_files });
