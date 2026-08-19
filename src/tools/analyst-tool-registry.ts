import { analystCardToolBinders } from './analyst-card-tools.js';
import { analystMiscToolBinders } from './analyst-misc-tools.js';
import { analystRuntimeToolBinders } from './analyst-runtime-tools.js';
import { analystNavigationToolBinders } from './analyst-workspace-tools.js';
import type { ToolContext } from './analyst-tool-types.js';
import type { ToolBinder } from './invocation.js';

let analystControlToolBinderCache: readonly ToolBinder<ToolContext, any>[] | null = null;

export function getAnalystControlToolBinders(): readonly ToolBinder<ToolContext, any>[] {
  if (analystControlToolBinderCache) return analystControlToolBinderCache;
  const byName = new Map<string, ToolBinder<ToolContext, any>>();
  for (const tool of [
    ...analystCardToolBinders,
    ...analystRuntimeToolBinders,
    ...analystNavigationToolBinders,
    ...analystMiscToolBinders,
  ]) {
    if (byName.has(tool.name)) throw new Error(`Duplicate Analyst tool definition for ${tool.name}`);
    byName.set(tool.name, tool);
  }
  analystControlToolBinderCache = Object.freeze([...byName.values()]);
  return analystControlToolBinderCache;
}
