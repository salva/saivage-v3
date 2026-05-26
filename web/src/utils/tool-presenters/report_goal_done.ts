import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'report_goal_done', call: callPresenters.report_goal_done, result: resultPresenters.report_goal_done });
