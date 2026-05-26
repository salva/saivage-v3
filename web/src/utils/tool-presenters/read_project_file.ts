import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_project_file', call: callPresenters.read_project_file, result: resultPresenters.read_project_file });
