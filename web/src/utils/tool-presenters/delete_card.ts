import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'delete_card', call: callPresenters.delete_card, result: resultPresenters.delete_card });
