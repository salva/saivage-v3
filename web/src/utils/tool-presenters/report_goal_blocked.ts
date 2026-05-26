import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'report_goal_blocked', call: callPresenters.report_goal_blocked, result: resultPresenters.report_goal_blocked });
