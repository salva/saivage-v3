import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'add_note', call: callPresenters.add_note, result: resultPresenters.add_note });
