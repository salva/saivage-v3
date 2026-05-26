import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'run_shell_command', call: callPresenters.run_shell_command, result: resultPresenters.run_shell_command });
