import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'create_card', call: callPresenters.create_card, result: resultPresenters.create_card });
