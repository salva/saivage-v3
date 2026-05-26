import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'edit_card', call: callPresenters.edit_card, result: resultPresenters.edit_card });
