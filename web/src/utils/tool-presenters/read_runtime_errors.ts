import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_runtime_errors', call: callPresenters.read_runtime_errors, result: resultPresenters.read_runtime_errors });
