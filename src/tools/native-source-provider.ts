import { emptyToolInputSchema, toolSucceeded } from '../contracts/index.js';
import {
  defineToolBinder,
  executeToolAction,
  OPERATIONAL_RESULT_POLICY_TEMPLATE,
} from './invocation.js';

export interface NativeSourceProviderContext {
  checkpointSource(): Promise<{ branch_ref: string; observed_tip: string }>;
}
export const nativeSourceToolBinders = [
  defineToolBinder({
    name: 'checkpoint_source',
    description:
      'Checkpoint this active card’s eligible source through its native runtime owner. No branch/path arguments or delivery. A checkpoint is not acceptance, and does not prove tests covered the resulting source. Finish source-writing commands first; native correction and ownership mismatches may refuse.',
    inputSchema: () => emptyToolInputSchema,
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
    executor: (context: NativeSourceProviderContext) =>
      executeToolAction('none', async () => toolSucceeded(await context.checkpointSource())),
  }),
];
