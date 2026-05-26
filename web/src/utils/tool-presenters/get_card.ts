import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_card', call: callPresenters.get_card, result: resultPresenters.get_card });
