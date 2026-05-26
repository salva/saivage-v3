import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'restart_card', call: callPresenters.restart_card, result: resultPresenters.restart_card });
