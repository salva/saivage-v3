import { describe, expect, it } from 'vitest';
import { buildToolDisplay, friendlyAction, groupToolPairs, isKnownTool, isToolGroup } from '../utils/tool-friendly';
import type { ToolPair } from '../utils/agent-timeline';
import type { AgentConversationEntry } from '../api/types';

function callContent(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ role: 'assistant', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

function entry(id: string, kind: AgentConversationEntry['kind'], content: string, tool?: string): AgentConversationEntry {
  return {
    id,
    session_id: 'analyst:global',
    role: kind === 'tool_result' ? 'tool' : 'assistant',
    kind,
    content,
    round_id: 'r',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00Z',
    tool,
    tool_call_id: `call-${tool ?? 'x'}`,
  } as AgentConversationEntry;
}

function pair(id: string, tool: string, status: ToolPair['status'], args: Record<string, unknown> = {}, resultBody: unknown = { success: true }): ToolPair {
  const call = entry(id, 'tool_call', callContent(tool, args), tool);
  const result = status === 'pending' ? null : entry(`${id}-r`, 'tool_result', JSON.stringify(resultBody), tool);
  return { call, result, status };
}

describe('friendlyAction', () => {
  it('maps builtin tools to friendly verbs', () => {
    expect(friendlyAction('read')).toBe('Read');
    expect(friendlyAction('run_command')).toBe('Shell');
    expect(friendlyAction('websearch')).toBe('Search');
    expect(friendlyAction('create_card')).toBe('Create');
  });

  it('falls back gracefully for unknown and MCP-registered tools', () => {
    expect(friendlyAction('mcp__github__create_issue')).toBe('MCP');
    expect(friendlyAction('custom_analyzer')).toBe('Analyzer');
    expect(friendlyAction('totally_new_tool')).toBe('Tool');
    expect(friendlyAction('restart_card')).toBe('Card');
    expect(isKnownTool('read')).toBe(true);
    expect(isKnownTool('mcp__anything')).toBe(false);
    expect(isKnownTool('brand_new_tool')).toBe(false);
    expect(isKnownTool('restart_card')).toBe(false);
  });
});

describe('buildToolDisplay', () => {
  it('renders a known pending tool with action, pending tone, and target routed from the call', () => {
    const display = buildToolDisplay(pair('c1', 'read', 'pending', { path: 'README.md' }));
    expect(display.action).toBe('Read');
    expect(display.known).toBe(true);
    const parts = [...display.target, ...display.links] as { text?: string; path?: string }[];
    expect(parts.some((p) => p.text === 'README.md' || p.path === 'README.md')).toBe(true);
    expect(display.status.map((p) => (p as { text?: string }).text)).toContain('running…');
    expect(display.statusTone).toBe('pending');
  });

  it('keeps non-interactive targets inline and surfaces an ok outcome status', () => {
    const display = buildToolDisplay(pair('c1', 'run_command', 'ok', { command: 'npm test' }, { success: true, data: { process_id: 'proc-1', exit_code: 0, status: 'exited', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 0, stderr_bytes: 0 } }));
    expect(display.action).toBe('Shell');
    expect(display.statusTone).toBe('ok');
  });

  it('produces a legible generic row for an unknown MCP tool', () => {
    const display = buildToolDisplay(pair('c1', 'mcp__github__create_issue', 'pending'));
    expect(display.action).toBe('MCP');
    expect(display.known).toBe(false);
  });

  it('derives a meaningful error status from the raw response', () => {
    const display = buildToolDisplay(pair('c1', 'run_command', 'error', { command: 'boom' }, { success: false, error: 'permission denied' }));
    expect(display.statusTone).toBe('error');
    expect(display.status.map((p) => (p as { text?: string }).text)).toContain('permission denied');
  });
});

function groupPair(id: string, tool: string, status: ToolPair['status']): ToolPair {
  return { call: entry(id, 'tool_call', callContent(tool, {}), tool), result: status === 'pending' ? null : entry(`${id}-r`, 'tool_result', JSON.stringify(status === 'error' ? { success: false, error: 'boom' } : { success: true }), tool), status };
}

describe('groupToolPairs', () => {
  it('collapses adjacent read-only context calls into a summary group', () => {
    const items = groupToolPairs('r1', [
      groupPair('c1', 'read', 'ok'),
      groupPair('c2', 'read', 'ok'),
      groupPair('c3', 'grep', 'ok'),
    ]);
    expect(items).toHaveLength(1);
    expect(isToolGroup(items[0])).toBe(true);
    if (isToolGroup(items[0])) {
      expect(items[0].label).toBe('Gathered context');
      expect(items[0].summary).toBe('2 Read, 1 Grep');
      expect(items[0].pairs).toHaveLength(3);
      expect(items[0].id).toContain('r1:group:context:');
    }
  });

  it('keeps web research separate from filesystem context', () => {
    const items = groupToolPairs('r1', [
      groupPair('c1', 'read', 'ok'),
      groupPair('c2', 'read', 'ok'),
      groupPair('c3', 'websearch', 'ok'),
      groupPair('c4', 'websearch', 'ok'),
    ]);
    expect(items).toHaveLength(2);
    expect(isToolGroup(items[0]) && items[0].label).toBe('Gathered context');
    expect(isToolGroup(items[1]) && items[1].label).toBe('Web research');
  });

  it('never groups mutations, errors, pending calls, or singletons', () => {
    const items = groupToolPairs('r1', [
      groupPair('c1', 'read', 'ok'),
      groupPair('c2', 'write', 'ok'),
      groupPair('c3', 'read', 'error'),
      groupPair('c4', 'run_command', 'ok'),
    ]);
    expect(items.every((item) => !isToolGroup(item))).toBe(true);
    expect(items).toHaveLength(4);
  });
});
