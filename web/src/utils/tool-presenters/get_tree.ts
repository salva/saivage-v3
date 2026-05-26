import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'get_tree', call: callPresenters.get_tree, result: resultPresenters.get_tree });
