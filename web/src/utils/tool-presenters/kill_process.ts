import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'kill_process', call: callPresenters.kill_process, result: resultPresenters.kill_process });
