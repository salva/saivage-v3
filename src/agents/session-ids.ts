export const GLOBAL_ANALYST_SESSION_ID = 'analyst:global';
export const SAFE_AGENT_SESSION_ID_RE = /^[a-zA-Z0-9_:-]+$/;

export function isSafeAgentSessionId(sessionId: string): boolean {
  return SAFE_AGENT_SESSION_ID_RE.test(sessionId);
}

export function resolveAnalystSessionId(sessionId?: string): string {
  if (!sessionId) return GLOBAL_ANALYST_SESSION_ID;
  return sessionId.startsWith('analyst:') ? sessionId : `analyst:${sessionId}`;
}
