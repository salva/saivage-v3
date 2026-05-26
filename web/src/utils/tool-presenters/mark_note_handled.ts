import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'mark_note_handled', call: callPresenters.mark_note_handled, result: resultPresenters.mark_note_handled });
