import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'abort_goal', call: callPresenters.abort_goal, result: resultPresenters.abort_goal });
