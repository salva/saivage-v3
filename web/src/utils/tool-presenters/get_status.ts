import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_status', call: callPresenters.get_status, result: resultPresenters.get_status });
