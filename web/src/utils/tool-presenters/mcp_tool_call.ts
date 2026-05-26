import { registerToolPresenter } from './registry';
import { callPresenters, resultPresenters } from './registrations';

registerToolPresenter({ name: 'mcp_tool_call', call: callPresenters.mcp_tool_call, result: resultPresenters.mcp_tool_call });
