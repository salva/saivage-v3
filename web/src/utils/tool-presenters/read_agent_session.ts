import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_agent_session', call: callPresenters.read_agent_session, result: resultPresenters.read_agent_session });
