import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_runtime_events', call: callPresenters.read_runtime_events, result: resultPresenters.read_runtime_events });
