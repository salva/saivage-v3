import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'webfetch', call: callPresenters.webfetch, result: resultPresenters.webfetch });
