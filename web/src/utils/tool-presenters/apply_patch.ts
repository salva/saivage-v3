import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'apply_patch', call: callPresenters.apply_patch, result: resultPresenters.apply_patch });
