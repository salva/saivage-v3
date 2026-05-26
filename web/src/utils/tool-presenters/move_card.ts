import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'move_card', call: callPresenters.move_card, result: resultPresenters.move_card });
