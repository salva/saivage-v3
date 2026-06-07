import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'edit', call: callPresenters.edit, result: resultPresenters.edit });
