import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { getActiveTmuxSession, unregisterTmuxSession } from "../infra/tmux-runner.js";
import { sendKeys, capturePane, killSession } from "../infra/tmux.js";

export function createSteeringTools(
  api: OpenClawPluginApi,
  _ctx: Record<string, unknown>,
): AnyAgentTool[] {
  return [
    // Tool 1: steer_agent
    {
      name: "steer_agent",
      label: "Steer Agent",
      description:
        "Send a message to the running coding agent. Only works for Claude/Gemini " +
        "(stdin-pipe mode). Codex is one-shot and cannot be steered mid-run. " +
        "Use this to inject precise, actionable instructions — do NOT forward raw user text.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text to inject into the agent's stdin. Should be a precise, actionable instruction.",
          },
          issueId: {
            type: "string",
            description: "Linear issue UUID of the running agent session.",
          },
        },
        required: ["text", "issueId"],
      },
      execute: async (_toolCallId: string, params: { text: string; issueId: string }) => {
        const { text, issueId } = params;
        const session = getActiveTmuxSession(issueId);
        if (!session) {
          return jsonResult({
            success: false,
            error: "no_active_session",
            message: `No active tmux session found for issue ${issueId}. The agent may have already completed.`,
          });
        }
        if (session.steeringMode === "one-shot") {
          return jsonResult({
            success: false,
            error: "one_shot_mode",
            message: `Cannot steer ${session.backend} — it runs in one-shot mode (Codex exec). ` +
              `You can abort and re-dispatch with updated instructions, or wait for it to complete.`,
            backend: session.backend,
          });
        }
        try {
          sendKeys(session.sessionName, text);
          api.logger.info(`steer_agent: sent ${text.length} chars to ${session.sessionName}`);
          return jsonResult({
            success: true,
            message: `Sent steering input to ${session.backend} agent (${session.issueIdentifier}).`,
            backend: session.backend,
            sessionName: session.sessionName,
          });
        } catch (err) {
          api.logger.error(`steer_agent error: ${err}`);
          return jsonResult({
            success: false,
            error: "send_failed",
            message: `Failed to send keys to tmux session: ${err}`,
          });
        }
      },
    } as unknown as AnyAgentTool,

    // Tool 2: capture_agent_output
    {
      name: "capture_agent_output",
      label: "Capture Agent Output",
      description:
        "Capture the last N lines of terminal output from the running coding agent. " +
        "Use this to check what the agent is doing before deciding whether to steer, respond, or abort.",
      parameters: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Linear issue UUID of the running agent session.",
          },
          lines: {
            type: "number",
            description: "Number of lines to capture (default: 50, max: 200).",
          },
        },
        required: ["issueId"],
      },
      execute: async (_toolCallId: string, params: { issueId: string; lines?: number }) => {
        const { issueId, lines } = params;
        const session = getActiveTmuxSession(issueId);
        if (!session) {
          return jsonResult({
            success: false,
            error: "no_active_session",
            message: `No active tmux session found for issue ${issueId}.`,
          });
        }
        try {
          const lineCount = Math.min(lines ?? 50, 200);
          const output = capturePane(session.sessionName, lineCount);
          return jsonResult({
            success: true,
            backend: session.backend,
            issueIdentifier: session.issueIdentifier,
            sessionName: session.sessionName,
            output: output || "(no output captured)",
            linesCaptured: lineCount,
          });
        } catch (err) {
          api.logger.error(`capture_agent_output error: ${err}`);
          return jsonResult({
            success: false,
            error: "capture_failed",
            message: `Failed to capture pane output: ${err}`,
          });
        }
      },
    } as unknown as AnyAgentTool,

    // Tool 3: abort_agent
    {
      name: "abort_agent",
      label: "Abort Agent",
      description:
        "Kill the running coding agent session. Use when the user wants to stop, retry with different instructions, " +
        "or when the agent is stuck. Works for all backends (Claude, Codex, Gemini).",
      parameters: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Linear issue UUID of the running agent session.",
          },
        },
        required: ["issueId"],
      },
      execute: async (_toolCallId: string, params: { issueId: string }) => {
        const { issueId } = params;
        const session = getActiveTmuxSession(issueId);
        if (!session) {
          return jsonResult({
            success: false,
            error: "no_active_session",
            message: `No active tmux session found for issue ${issueId}. It may have already completed.`,
          });
        }
        try {
          killSession(session.sessionName);
          unregisterTmuxSession(issueId);
          api.logger.info(`abort_agent: killed ${session.sessionName} (${session.backend})`);
          return jsonResult({
            success: true,
            message: `Killed ${session.backend} agent for ${session.issueIdentifier}. ` +
              `The session has been terminated. You can re-dispatch with updated instructions.`,
            backend: session.backend,
            issueIdentifier: session.issueIdentifier,
          });
        } catch (err) {
          api.logger.error(`abort_agent error: ${err}`);
          // Still try to unregister even if kill fails
          unregisterTmuxSession(issueId);
          return jsonResult({
            success: false,
            error: "kill_failed",
            message: `Failed to kill tmux session: ${err}. Session unregistered from registry.`,
          });
        }
      },
    } as unknown as AnyAgentTool,
  ];
}
