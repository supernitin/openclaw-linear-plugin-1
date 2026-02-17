import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActivityContent } from "./linear-api.js";
import {
  buildLinearApi,
  resolveSession,
  extractPrompt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BASE_REPO,
  type CliToolParams,
  type CliResult,
} from "./cli-shared.js";

const CODEX_BIN = "/home/claw/.npm-global/bin/codex";

/**
 * Parse a JSONL line from `codex exec --json` and map it to a Linear activity.
 */
function mapCodexEventToActivity(event: any): ActivityContent | null {
  const eventType = event?.type;
  const item = event?.item;

  if (item?.type === "reasoning") {
    const text = item.text ?? "";
    return { type: "thought", body: text ? text.slice(0, 500) : "Reasoning..." };
  }

  if (
    (eventType === "item.completed" || eventType === "item.started") &&
    (item?.type === "agent_message" || item?.type === "message")
  ) {
    const text = item.text ?? item.content ?? "";
    if (text) return { type: "thought", body: text.slice(0, 1000) };
    return null;
  }

  if (eventType === "item.started" && item?.type === "command_execution") {
    const cmd = item.command ?? "unknown";
    const cleaned = typeof cmd === "string"
      ? cmd.replace(/^\/usr\/bin\/\w+ -lc ['"]?/, "").replace(/['"]?$/, "")
      : JSON.stringify(cmd);
    return { type: "action", action: "Running", parameter: cleaned.slice(0, 200) };
  }

  if (eventType === "item.completed" && item?.type === "command_execution") {
    const cmd = item.command ?? "unknown";
    const exitCode = item.exit_code ?? "?";
    const output = item.aggregated_output ?? item.output ?? "";
    const cleaned = typeof cmd === "string"
      ? cmd.replace(/^\/usr\/bin\/\w+ -lc ['"]?/, "").replace(/['"]?$/, "")
      : JSON.stringify(cmd);
    const truncated = output.length > 500 ? output.slice(0, 500) + "..." : output;
    return {
      type: "action",
      action: `${cleaned.slice(0, 150)}`,
      parameter: `exit ${exitCode}`,
      result: truncated || undefined,
    };
  }

  if (eventType === "item.completed" && item?.type === "file_changes") {
    const files = item.files ?? [];
    const fileList = Array.isArray(files) ? files.join(", ") : String(files);
    return { type: "action", action: "Modified files", parameter: fileList || "unknown files" };
  }

  if (eventType === "turn.completed") {
    const usage = event.usage;
    if (usage) {
      const input = usage.input_tokens ?? 0;
      const cached = usage.cached_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      return { type: "thought", body: `Codex turn complete (${input} in / ${cached} cached / ${output} out tokens)` };
    }
    return { type: "thought", body: "Codex turn complete" };
  }

  return null;
}

/**
 * Run Codex CLI with JSONL streaming, mapping events to Linear activities in real-time.
 */
export async function runCodex(
  api: OpenClawPluginApi,
  params: CliToolParams,
  pluginConfig?: Record<string, unknown>,
): Promise<CliResult> {
  api.logger.info(`codex_run params: ${JSON.stringify(params).slice(0, 500)}`);

  const prompt = extractPrompt(params);
  if (!prompt) {
    return {
      success: false,
      output: `codex_run error: no prompt provided. Received keys: ${Object.keys(params).join(", ")}`,
      error: "missing prompt",
    };
  }

  const { model, timeoutMs } = params;
  const { agentSessionId, issueIdentifier } = resolveSession(params);

  api.logger.info(`codex_run: session=${agentSessionId ?? "none"}, issue=${issueIdentifier ?? "none"}`);

  const timeout = timeoutMs ?? (pluginConfig?.codexTimeoutMs as number) ?? DEFAULT_TIMEOUT_MS;
  const workingDir = params.workingDir ?? (pluginConfig?.codexBaseRepo as string) ?? DEFAULT_BASE_REPO;

  // Build Linear API for activity streaming
  const linearApi = buildLinearApi(api, agentSessionId);

  if (linearApi && agentSessionId) {
    await linearApi.emitActivity(agentSessionId, {
      type: "thought",
      body: `Starting Codex: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
    }).catch(() => {});
  }

  // Build codex command
  const args = ["exec", "--full-auto", "--json", "--ephemeral"];
  if (model ?? pluginConfig?.codexModel) {
    args.push("--model", (model ?? pluginConfig?.codexModel) as string);
  }
  args.push("-C", workingDir);
  args.push(prompt);

  api.logger.info(`Codex exec: ${CODEX_BIN} ${args.join(" ").slice(0, 200)}...`);

  return new Promise<CliResult>((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 0,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5_000);
    }, timeout);

    const collectedMessages: string[] = [];
    const collectedCommands: string[] = [];
    let stderrOutput = "";

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        collectedMessages.push(line);
        return;
      }

      const item = event?.item;

      if (
        event?.type === "item.completed" &&
        (item?.type === "agent_message" || item?.type === "message")
      ) {
        const text = item.text ?? item.content ?? "";
        if (text) collectedMessages.push(text);
      }

      // Skip reasoning events from final output — they're streamed to
      // Linear as activities but don't belong in the returned result.

      if (event?.type === "item.completed" && item?.type === "command_execution") {
        const cmd = item.command ?? "unknown";
        const exitCode = item.exit_code ?? "?";
        const output = item.aggregated_output ?? item.output ?? "";
        const cleanCmd = typeof cmd === "string"
          ? cmd.replace(/^\/usr\/bin\/\w+ -lc ['"]?/, "").replace(/['"]?$/, "")
          : String(cmd);
        const truncOutput = output.length > 500 ? output.slice(0, 500) + "..." : output;
        collectedCommands.push(`\`${cleanCmd}\` → exit ${exitCode}${truncOutput ? "\n```\n" + truncOutput + "\n```" : ""}`);
      }

      const activity = mapCodexEventToActivity(event);
      if (activity && linearApi && agentSessionId) {
        linearApi.emitActivity(agentSessionId, activity).catch((err) => {
          api.logger.warn(`Failed to emit Codex activity: ${err}`);
        });
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      rl.close();

      const parts: string[] = [];
      if (collectedMessages.length > 0) parts.push(collectedMessages.join("\n\n"));
      if (collectedCommands.length > 0) parts.push(collectedCommands.join("\n\n"));
      const output = parts.join("\n\n") || stderrOutput || "(no output)";

      if (killed) {
        api.logger.warn(`Codex timed out after ${timeout}ms`);
        resolve({
          success: false,
          output: `Codex timed out after ${Math.round(timeout / 1000)}s. Partial output:\n${output}`,
          error: "timeout",
        });
        return;
      }

      if (code !== 0) {
        api.logger.warn(`Codex exited with code ${code}`);
        resolve({
          success: false,
          output: `Codex failed (exit ${code}):\n${output}`,
          error: `exit ${code}`,
        });
        return;
      }

      api.logger.info(`Codex completed successfully`);
      resolve({ success: true, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rl.close();
      api.logger.error(`Codex spawn error: ${err}`);
      resolve({
        success: false,
        output: `Failed to start Codex: ${err.message}`,
        error: err.message,
      });
    });
  });
}

