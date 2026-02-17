/**
 * active-session.ts — Idempotent registry of active Linear agent sessions.
 *
 * When the pipeline starts work on an issue, it registers the session here.
 * Any tool (code_run, etc.) can look up the active session for the current
 * issue to stream activities without relying on the LLM agent to pass params.
 *
 * This runs in the gateway process. Tool execution also happens in the gateway,
 * so tools can read from this registry directly.
 */

export interface ActiveSession {
  agentSessionId: string;
  issueIdentifier: string;
  issueId: string;
  agentId?: string;
  startedAt: number;
}

// Keyed by issue ID — one active session per issue at a time.
const sessions = new Map<string, ActiveSession>();

/**
 * Register the active session for an issue. Idempotent — calling again
 * for the same issue just updates the session.
 */
export function setActiveSession(session: ActiveSession): void {
  sessions.set(session.issueId, session);
}

/**
 * Clear the active session for an issue.
 */
export function clearActiveSession(issueId: string): void {
  sessions.delete(issueId);
}

/**
 * Look up the active session for an issue by issue ID.
 */
export function getActiveSession(issueId: string): ActiveSession | null {
  return sessions.get(issueId) ?? null;
}

/**
 * Look up the active session by issue identifier (e.g. "API-472").
 * Slower than by ID — scans all sessions.
 */
export function getActiveSessionByIdentifier(identifier: string): ActiveSession | null {
  for (const session of sessions.values()) {
    if (session.issueIdentifier === identifier) return session;
  }
  return null;
}

/**
 * Get the current active session. If there's exactly one, return it.
 * If there are multiple (concurrent pipelines), returns null — caller
 * must specify which issue.
 */
export function getCurrentSession(): ActiveSession | null {
  if (sessions.size === 1) {
    return sessions.values().next().value ?? null;
  }
  return null;
}
