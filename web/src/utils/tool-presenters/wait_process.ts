import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'wait_process', call: callPresenters.wait_process, result: resultPresenters.wait_process });
