import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'skill', call: callPresenters.skill, result: resultPresenters.skill });
