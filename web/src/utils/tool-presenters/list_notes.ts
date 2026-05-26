import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_notes', call: callPresenters.list_notes, result: resultPresenters.list_notes });
