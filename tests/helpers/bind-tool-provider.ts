import type { ToolBinder, ToolProvider } from '../../src/tools/invocation.js';

export function bindToolProvider<Context>(providerName: string, binders: readonly ToolBinder<Context, any>[], context: Context): ToolProvider {
  return { providerName, tools: binders.map((binder) => binder.bind(context)) };
}
