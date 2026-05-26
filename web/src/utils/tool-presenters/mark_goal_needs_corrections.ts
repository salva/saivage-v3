import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'mark_goal_needs_corrections', call: callPresenters.mark_goal_needs_corrections, result: resultPresenters.mark_goal_needs_corrections });
