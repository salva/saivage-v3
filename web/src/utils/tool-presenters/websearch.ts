import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'websearch', call: callPresenters.websearch, result: resultPresenters.websearch });
