import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'load_skill', call: callPresenters.load_skill, result: resultPresenters.load_skill });
