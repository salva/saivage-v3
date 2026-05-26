import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'restart_goal', call: callPresenters.restart_goal, result: resultPresenters.restart_goal });
