import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'report_goal_failed', call: callPresenters.report_goal_failed, result: resultPresenters.report_goal_failed });
