import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'cancel_card', call: callPresenters.cancel_card, result: resultPresenters.cancel_card });
