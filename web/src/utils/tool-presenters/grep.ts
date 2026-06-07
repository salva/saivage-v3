import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'grep', call: callPresenters.grep, result: resultPresenters.grep });
