import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'write', call: callPresenters.write, result: resultPresenters.write });
