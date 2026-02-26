/**
 * retro.ts — Post-dispatch retrospective spawner.
 *
 * After a dispatch completes (pass, fail, or stuck), spawns a sub-agent
 * that analyzes the full interaction and writes a structured retrospective
 * to the shared coding directory. Past retros are discoverable via QMD
 * memory_search, enabling pattern detection across dispatches.
 *
 * Output format: YAML frontmatter + markdown sections with priority tags
 * and actionable recommendations.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runAgent } from "../agent/agent.js";
import { readWorkerOutputs, readAuditVerdicts, readLog } from "./artifacts.js";
import type { ActiveDispatch, CompletedDispatch } from "./dispatch-state.js";
import type { AuditVerdict } from "./pipeline.js";
import type { HookContext } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Shared coding directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the shared coding directory for retrospective files.
 *
 * Resolution order:
 * 1. pluginConfig.retroDir (explicit override, supports ~/ expansion)
 * 2. api.runtime.config.loadConfig().stateDir + "/shared/coding"
 * 3. Fallback: ~/.openclaw/shared/coding
 */
export function resolveSharedCodingDir(
  api: OpenClawPluginApi,
  pluginConfig?: Record<string, unknown>,
): string {
  // 1. Explicit plugin config override (supports ~/expansion)
  const custom = pluginConfig?.retroDir as string | undefined;
  if (custom) {
    return custom.startsWith("~/") ? custom.replace("~", homedir()) : custom;
  }

  // 2. Derive from gateway config stateDir
  try {
    const config = (api as any).runtime.config.loadConfig() as Record<string, any>;
    const rawStateDir = config?.stateDir as string | undefined;
    const stateDir = rawStateDir
      ? (rawStateDir.startsWith("~/")
          ? rawStateDir.replace("~", homedir())
          : rawStateDir)
      : join(homedir(), ".openclaw");
    return join(stateDir, "shared", "coding");
  } catch {
    // 3. Safe fallback
    return join(homedir(), ".openclaw", "shared", "coding");
  }
}

// ---------------------------------------------------------------------------
// Agent ID resolution (mirrors webhook.ts pattern)
// ---------------------------------------------------------------------------

function resolveAgentId(api: OpenClawPluginApi): string {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const fromConfig = pluginConfig?.defaultAgentId;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;
  return "default";
}

// ---------------------------------------------------------------------------
// Retrospective artifacts interface
// ---------------------------------------------------------------------------

export interface RetroArtifacts {
  verdict?: AuditVerdict;
  summary?: string;
  prUrl?: string;
  workerOutputs: string[];
  auditVerdicts: string[];
  logEntries: string[];
}

// ---------------------------------------------------------------------------
// spawnRetrospective
// ---------------------------------------------------------------------------

/**
 * Spawn a sub-agent to create a structured retrospective after dispatch
 * completion. The agent analyzes worker outputs, audit verdicts, and the
 * interaction log, then writes a retro file with YAML frontmatter.
 *
 * Designed to be called fire-and-forget (non-blocking):
 *   void spawnRetrospective(hookCtx, dispatch, artifacts).catch(...)
 *
 * The retro agent has access to memory_search to find past retros and
 * detect recurring patterns.
 */
export async function spawnRetrospective(
  hookCtx: HookContext,
  dispatch: ActiveDispatch | CompletedDispatch,
  artifacts: RetroArtifacts,
): Promise<void> {
  const { api, pluginConfig } = hookCtx;
  const TAG = `[retro:${dispatch.issueIdentifier}]`;

  const codingDir = resolveSharedCodingDir(api, pluginConfig);

  // Ensure the shared coding directory exists
  if (!existsSync(codingDir)) {
    mkdirSync(codingDir, { recursive: true });
  }

  // Compute duration from dispatchedAt if available (ActiveDispatch has it)
  let durationMs: number | undefined;
  if ("dispatchedAt" in dispatch && dispatch.dispatchedAt) {
    durationMs = Date.now() - new Date(dispatch.dispatchedAt).getTime();
  }

  // Resolve fields that may differ between ActiveDispatch and CompletedDispatch
  const issueTitle = ("issueTitle" in dispatch ? dispatch.issueTitle : undefined) ?? dispatch.issueIdentifier;
  const model = "model" in dispatch ? dispatch.model : "unknown";
  const tier = dispatch.tier;
  const status = dispatch.status;
  const attempt = "attempt" in dispatch
    ? (dispatch.attempt ?? 0)
    : ("totalAttempts" in dispatch ? (dispatch.totalAttempts ?? 0) : 0);
  const worktreePath = "worktreePath" in dispatch ? dispatch.worktreePath : undefined;

  const dateStr = new Date().toISOString().slice(0, 10);
  const retroFilename = `retro-${dateStr}-${dispatch.issueIdentifier}.md`;
  const retroPath = join(codingDir, retroFilename);

  // Build the retro prompt
  const retroPrompt = [
    `You are a coding retrospective analyst. A dispatch just completed.`,
    `Analyze the interaction and create a structured retrospective.`,
    ``,
    `## Dispatch Details`,
    `- Issue: ${dispatch.issueIdentifier} — ${issueTitle}`,
    `- Backend: ${model} | Tier: ${tier}`,
    `- Attempts: ${attempt + 1} | Status: ${status}`,
    worktreePath ? `- Worktree: ${worktreePath}` : "",
    durationMs != null ? `- Duration: ${Math.round(durationMs / 1000)}s` : "",
    artifacts.prUrl ? `- PR: ${artifacts.prUrl}` : "",
    ``,
    `## Worker Outputs (${artifacts.workerOutputs.length} attempts)`,
    artifacts.workerOutputs
      .map((o, i) => `### Attempt ${i}\n${o.slice(0, 3000)}`)
      .join("\n\n"),
    ``,
    `## Audit Verdicts`,
    artifacts.auditVerdicts
      .map((v, i) => `### Attempt ${i}\n${v}`)
      .join("\n\n"),
    ``,
    `## Interaction Log`,
    artifacts.logEntries.length > 0
      ? artifacts.logEntries.slice(-20).map((e) => `- ${e}`).join("\n")
      : "(no log entries)",
    ``,
    `## Instructions`,
    ``,
    `**First**, use \`memory_search\` to find past retros related to this issue's`,
    `domain, backend, or error patterns. Look for recurring friction points.`,
    ``,
    `**Then**, write a retrospective file to: ${retroPath}`,
    ``,
    `Use this exact format — YAML frontmatter followed by markdown sections:`,
    ``,
    "```yaml",
    `---`,
    `type: retro`,
    `issue: ${dispatch.issueIdentifier}`,
    `title: "${issueTitle}"`,
    `backend: ${model}`,
    `tier: ${tier}`,
    `status: ${status}`,
    `attempts: ${attempt + 1}`,
    `date: ${dateStr}`,
    durationMs != null ? `duration_ms: ${durationMs}` : "",
    `---`,
    "```",
    ``,
    `Sections (all required):`,
    ``,
    `## Summary`,
    `Brief description of what was done and outcome.`,
    ``,
    `## What Went Well`,
    `- [P1/P2/P3] Items that worked. Tag each with priority.`,
    ``,
    `## Friction Points`,
    `- [P1/P2/P3:CATEGORY] Issues encountered.`,
    `  Categories: PROCESS, ENV, TOOLING, PROMPT, CONFIG`,
    ``,
    `## Environment Issues`,
    `- [P1/P2/P3:ENV] Environment-specific problems.`,
    ``,
    `## Recommendations`,
    `- [RECOMMEND:target] Specific changes to prevent future friction.`,
    `  Targets: AGENTS.md, CLAUDE.md, config, prompt, codex-config, etc.`,
    ``,
    `## Actionable Items`,
    `- [ ] Checkbox items for follow-up.`,
    ``,
    `Focus on patterns that would help FUTURE dispatches succeed faster:`,
    `- What context was missing that caused extra attempts?`,
    `- What environment setup tripped up the agent?`,
    `- What prompt improvements would have helped?`,
    `- What bootstrap file changes would prevent this friction?`,
    `- Compare against past retros — are we seeing recurring patterns?`,
  ].filter(Boolean).join("\n");

  api.logger.info(`${TAG} spawning retrospective agent → ${retroPath}`);

  const agentId = resolveAgentId(api);

  try {
    await runAgent({
      api,
      agentId,
      sessionId: `retro-${dispatch.issueIdentifier}-${Date.now()}`,
      message: retroPrompt,
      timeoutMs: 120_000, // 2min max for retro
    });
    api.logger.info(`${TAG} retrospective complete → ${retroFilename}`);
  } catch (err) {
    api.logger.warn(`${TAG} retrospective agent failed: ${err}`);
  }
}
