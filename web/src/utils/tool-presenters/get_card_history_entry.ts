import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_card_history_entry', call: callPresenters.get_card_history_entry, result: resultPresenters.get_card_history_entry });
