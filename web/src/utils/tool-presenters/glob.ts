import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'glob', call: callPresenters.glob, result: resultPresenters.glob });
