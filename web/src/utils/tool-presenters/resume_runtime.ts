import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'resume_runtime', call: callPresenters.resume_runtime, result: resultPresenters.resume_runtime });
