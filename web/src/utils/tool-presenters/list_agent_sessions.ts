import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_agent_sessions', call: callPresenters.list_agent_sessions, result: resultPresenters.list_agent_sessions });
