import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

for (const name of [
  'abort_goal_subtree',
  'navigate_back',
  'navigate_workspace',
  'queue_notification',
  'reconfigure',
  'reorder_child',
  'restart_card_or_subtree',
  'restart_server',
  'show_config',
  'start_project',
  'stop_project',
] as const) {
  registerToolPresenter({ name, call: callPresenters[name], result: resultPresenters[name] });
}
