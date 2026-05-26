import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'start_and_wait', call: callPresenters.start_and_wait, result: resultPresenters.start_and_wait });
