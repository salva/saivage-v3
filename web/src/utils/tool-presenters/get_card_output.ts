import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_card_output', call: callPresenters.get_card_output, result: resultPresenters.get_card_output });
