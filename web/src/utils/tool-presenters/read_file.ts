import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'read_file', call: callPresenters.read_file, result: resultPresenters.read_file });
