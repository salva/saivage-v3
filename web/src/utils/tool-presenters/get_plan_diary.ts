import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_plan_diary', call: callPresenters.get_plan_diary, result: resultPresenters.get_plan_diary });
