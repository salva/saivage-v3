import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_card_history', call: callPresenters.list_card_history, result: resultPresenters.list_card_history });
