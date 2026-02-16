import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export interface AgentRunResult {
  success: boolean;
  output: string;
}

export async function runAgent(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  message: string;
  timeoutMs?: number;
}): Promise<AgentRunResult> {
  const { api, agentId, sessionId, message, timeoutMs = 5 * 60_000 } = params;

  api.logger.info(`Dispatching agent ${agentId} for session ${sessionId}`);

  const command = [
    "openclaw",
    "agent",
    "--agent",
    agentId,
    "--session-id",
    sessionId,
    "--message",
    message,
    "--timeout",
    String(Math.floor(timeoutMs / 1000)),
    "--json",
  ];

  const result = await api.runtime.system.runCommandWithTimeout(command, { timeoutMs });

  if (result.code !== 0) {
    const error = result.stderr || result.stdout || "no output";
    api.logger.error(`Agent ${agentId} failed (${result.code}): ${error}`);
    return { success: false, output: error };
  }

  const raw = result.stdout || "";
  api.logger.info(`Agent ${agentId} completed for session ${sessionId}`);

  // Extract clean text from --json output
  try {
    const parsed = JSON.parse(raw);
    const payloads = parsed?.result?.payloads;
    if (Array.isArray(payloads) && payloads.length > 0) {
      const text = payloads.map((p: any) => p.text).filter(Boolean).join("\n\n");
      if (text) return { success: true, output: text };
    }
  } catch {
    // Not JSON — use raw output as-is
  }

  return { success: true, output: raw };
}
