import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'run_project_command', call: callPresenters.run_project_command, result: resultPresenters.run_project_command });
