import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runAgent } from "../agent/agent.js";

/**
 * Search agent memory by running a short read-only agent session.
 *
 * The agent has access to memory_search, read, glob, grep tools
 * (readOnly mode allows these). It returns search results as text.
 *
 * @param api - OpenClaw plugin API
 * @param agentId - Agent ID to use for the session
 * @param query - Search query string
 * @param timeoutMs - Max time for the search session (default 15s)
 * @returns Text output from the memory search, or empty string on failure
 */
export async function searchMemoryViaAgent(
  api: OpenClawPluginApi,
  agentId: string,
  query: string,
  timeoutMs = 15_000,
): Promise<string> {
  try {
    const result = await runAgent({
      api,
      agentId,
      sessionId: `memory-search-${Date.now()}`,
      message: [
        `Search your memory for information relevant to: "${query}"`,
        `Return ONLY the search results as a bulleted list, one result per line.`,
        `Include the most relevant content snippets. No commentary or explanation.`,
        `If no results found, return exactly: "No relevant memories found."`,
      ].join("\n"),
      timeoutMs,
      readOnly: true,
    });
    return result.success ? result.output : "";
  } catch {
    return "";
  }
}
