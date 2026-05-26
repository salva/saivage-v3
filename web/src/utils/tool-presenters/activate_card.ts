import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'activate_card', call: callPresenters.activate_card, result: resultPresenters.activate_card });
