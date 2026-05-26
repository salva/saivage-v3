import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'wait_for_process', call: callPresenters.wait_for_process, result: resultPresenters.wait_for_process });
