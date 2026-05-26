import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'write_project_file', call: callPresenters.write_project_file, result: resultPresenters.write_project_file });
