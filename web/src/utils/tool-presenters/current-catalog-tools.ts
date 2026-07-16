import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

for (const name of [
  'navigate_back',
  'navigate_workspace',
  'queue_notification',
  'reconfigure',
  'reorder_child',
  'restart_server',
  'stop_project',
  'show_config',
  'start_project',
] as const) {
  registerToolPresenter({ name, call: callPresenters[name], result: resultPresenters[name] });
}
