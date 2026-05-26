import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_processes_tool', call: callPresenters.list_processes_tool, result: resultPresenters.list_processes_tool });
