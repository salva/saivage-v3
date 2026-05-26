import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'pause_runtime', call: callPresenters.pause_runtime, result: resultPresenters.pause_runtime });
