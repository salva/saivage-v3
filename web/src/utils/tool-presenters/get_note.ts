import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_note', call: callPresenters.get_note, result: resultPresenters.get_note });
