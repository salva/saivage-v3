import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_cards', call: callPresenters.list_cards, result: resultPresenters.list_cards });
