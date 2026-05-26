import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'diff_card', call: callPresenters.diff_card, result: resultPresenters.diff_card });
