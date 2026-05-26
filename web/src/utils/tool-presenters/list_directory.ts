import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'list_directory', call: callPresenters.list_directory, result: resultPresenters.list_directory });
