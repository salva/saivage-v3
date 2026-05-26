import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_control_actions', call: callPresenters.read_control_actions, result: resultPresenters.read_control_actions });
