import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'emit_result', call: callPresenters.emit_result, result: resultPresenters.emit_result });
