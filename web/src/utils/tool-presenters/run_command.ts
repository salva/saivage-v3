import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'run_command', call: callPresenters.run_command, result: resultPresenters.run_command });
