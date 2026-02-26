/**
 * tmux-runner.ts — Shared tmux runner with pipe-pane JSONL streaming
 * and in-memory session registry.
 *
 * Wraps CLI processes (Claude, Codex, Gemini) in tmux sessions, captures
 * JSONL output via pipe-pane log files, and streams parsed events as Linear
 * activities. Provides a session registry for steering (Phase 2) and
 * orphan recovery on gateway restart.
 *
 * Flow:
 *   1. Create tmux session + pipe-pane → JSONL log file
 *   2. Send CLI command via sendKeys
 *   3. Tail log file with fs.watch() + manual offset tracking
 *   4. Parse JSONL lines → tick watchdog → emit activities → collect output
 *   5. Detect completion (exit marker, session death, timeout, or watchdog kill)
 *   6. Clean up and return CliResult
 */
import {
  createSession,
  setupPipePane,
  sendKeys,
  killSession,
  sessionExists,
  listSessions,
} from "./tmux.js";
import { InactivityWatchdog } from "../agent/watchdog.js";
import type { ActivityContent } from "../api/linear-api.js";
import type { LinearAgentApi } from "../api/linear-api.js";
import type { CliResult, OnProgressUpdate } from "../tools/cli-shared.js";
import { formatActivityLogLine, createProgressEmitter } from "../tools/cli-shared.js";
import type { DispatchState } from "../pipeline/dispatch-state.js";
import {
  writeFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Session Registry
// ---------------------------------------------------------------------------

export interface TmuxSessionInfo {
  sessionName: string;
  backend: string;
  issueId: string;            // Linear UUID — matches activeRuns key
  issueIdentifier: string;    // Human-friendly key (UAT-123)
  startedAt: number;
  steeringMode: "stdin-pipe" | "one-shot";
}

const activeTmuxSessions = new Map<string, TmuxSessionInfo>();

/**
 * Look up an active tmux session by Linear issue UUID.
 * Returns null if no session is registered for this issue.
 */
export function getActiveTmuxSession(issueId: string): TmuxSessionInfo | null {
  return activeTmuxSessions.get(issueId) ?? null;
}

/**
 * Register a tmux session in the in-memory map.
 * Keyed by issueId (Linear UUID) to match the activeRuns set.
 */
export function registerTmuxSession(info: TmuxSessionInfo): void {
  activeTmuxSessions.set(info.issueId, info);
}

/**
 * Remove a tmux session from the registry.
 */
export function unregisterTmuxSession(issueId: string): void {
  activeTmuxSessions.delete(issueId);
}

/**
 * List all registered tmux sessions (for diagnostics).
 */
export function listRegisteredSessions(): TmuxSessionInfo[] {
  return Array.from(activeTmuxSessions.values());
}

// ---------------------------------------------------------------------------
// Exit marker — appended after the CLI command so we can detect completion
// ---------------------------------------------------------------------------

const EXIT_MARKER = "::TMUX_EXIT::";

// ---------------------------------------------------------------------------
// TmuxRunnerOpts
// ---------------------------------------------------------------------------

export interface TmuxRunnerOpts {
  issueId: string;
  issueIdentifier: string;
  sessionName: string;
  command: string;              // Full CLI command string (shell-escaped)
  cwd: string;
  timeoutMs: number;
  watchdogMs: number;
  logPath: string;              // pipe-pane JSONL log path
  mapEvent: (event: any) => ActivityContent | null;
  linearApi?: LinearAgentApi;
  agentSessionId?: string;
  steeringMode: "stdin-pipe" | "one-shot";
  logger?: { info: (...a: any[]) => void; warn: (...a: any[]) => void };
  onUpdate?: OnProgressUpdate;
  progressHeader?: string;
}

// ---------------------------------------------------------------------------
// runInTmux
// ---------------------------------------------------------------------------

/**
 * Run a CLI command inside a tmux session with pipe-pane JSONL streaming.
 *
 * Creates the tmux session, pipes output to a JSONL log file, tails the
 * log with fs.watch(), parses events, streams activities to Linear, and
 * returns a CliResult when the process completes (or is killed).
 */
export async function runInTmux(opts: TmuxRunnerOpts): Promise<CliResult> {
  const {
    issueId,
    issueIdentifier,
    sessionName,
    command,
    cwd,
    timeoutMs,
    watchdogMs,
    logPath,
    mapEvent,
    linearApi,
    agentSessionId,
    steeringMode,
    logger,
  } = opts;

  const log = logger ?? {
    info: (...a: any[]) => console.log("[tmux-runner]", ...a),
    warn: (...a: any[]) => console.warn("[tmux-runner]", ...a),
  };

  // 1. Ensure log directory and file exist
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(logPath, "", { flag: "w" });

  // 2. Create tmux session
  log.info(`Creating tmux session: ${sessionName} in ${cwd}`);
  createSession(sessionName, cwd);

  // 3. Set up pipe-pane to stream JSONL to the log file
  setupPipePane(sessionName, logPath);

  // 4. Register in session map
  const sessionInfo: TmuxSessionInfo = {
    sessionName,
    backend: extractBackend(sessionName),
    issueId,
    issueIdentifier,
    startedAt: Date.now(),
    steeringMode,
  };
  registerTmuxSession(sessionInfo);

  // 5. Send the CLI command, chained with exit marker echo
  //    Use ; (not &&) so the marker fires even if the command fails.
  //    The echo writes a JSON object to stdout which pipe-pane captures.
  const exitEcho = `echo '{"type":"::TMUX_EXIT::","exitCode":'$?'}'`;
  sendKeys(sessionName, `${command} ; ${exitEcho}`);

  log.info(`Command sent to ${sessionName}: ${command.slice(0, 200)}...`);

  // 5b. Set up session progress emitter
  const progress = createProgressEmitter({
    header: opts.progressHeader ?? `[${extractBackend(sessionName)}] ${cwd}\n$ ${command}`,
    onUpdate: opts.onUpdate,
  });
  progress.emitHeader();

  // 6. Start tailing the log file
  return new Promise<CliResult>((resolve) => {
    let resolved = false;
    let killed = false;
    let killedByWatchdog = false;
    let exitCode: number | null = null;

    // Collected output for CliResult
    const collectedMessages: string[] = [];
    const collectedCommands: string[] = [];

    // File read offset tracking
    let bytesRead = 0;
    let lineBuffer = "";

    // Watcher and timers
    let watcher: FSWatcher | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // --- Watchdog ---
    const watchdog = new InactivityWatchdog({
      inactivityMs: watchdogMs,
      label: `tmux:${sessionName}`,
      logger: log,
      onKill: () => {
        killedByWatchdog = true;
        killed = true;
        log.warn(`Watchdog killed tmux session: ${sessionName}`);
        killSession(sessionName);
        finish();
      },
    });

    // --- Process new bytes from the log file ---
    function readNewBytes(): void {
      let fd: number | null = null;
      try {
        // Get current file size
        const stats = statSync(logPath);
        const fileSize = stats.size;
        if (fileSize <= bytesRead) return;

        fd = openSync(logPath, "r");
        const toRead = fileSize - bytesRead;
        const buf = Buffer.alloc(toRead);
        const nread = readSync(fd, buf, 0, toRead, bytesRead);
        closeSync(fd);
        fd = null;

        if (nread <= 0) return;
        bytesRead += nread;

        // Combine with leftover from previous read
        const chunk = lineBuffer + buf.toString("utf8", 0, nread);
        const lines = chunk.split("\n");

        // Last element is either empty (line ended with \n) or a partial line
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          processLine(trimmed);
        }
      } catch (err: any) {
        // File may have been deleted or is inaccessible during cleanup
        if (err.code !== "ENOENT") {
          log.warn(`Error reading log file: ${err.message}`);
        }
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
    }

    // --- Process a single JSONL line ---
    function processLine(line: string): void {
      watchdog.tick();

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON line that made it through the grep filter — collect as raw output
        collectedMessages.push(line);
        return;
      }

      // Check for our exit marker
      if (event?.type === EXIT_MARKER) {
        exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
        // Don't finish yet — let the session poll detect death
        // (there may be trailing events still being written)
        return;
      }

      // Collect structured output (same pattern as codex-tool.ts)
      const item = event?.item;
      const eventType = event?.type;

      // Collect agent messages
      if (
        (eventType === "item.completed" || eventType === "item.started") &&
        (item?.type === "agent_message" || item?.type === "message")
      ) {
        const text = item.text ?? item.content ?? "";
        if (text) collectedMessages.push(text);
      }

      // Collect assistant text blocks (Claude format)
      if (eventType === "assistant" || eventType === "result") {
        const text = event?.text ?? event?.result ?? "";
        if (text) collectedMessages.push(text);
      }

      // Collect completed commands
      if (eventType === "item.completed" && item?.type === "command_execution") {
        const cmd = item.command ?? "unknown";
        const code = item.exit_code ?? "?";
        const output = item.aggregated_output ?? item.output ?? "";
        const cleanCmd = typeof cmd === "string"
          ? cmd.replace(/^\/usr\/bin\/\w+ -lc ['"]?/, "").replace(/['"]?$/, "")
          : String(cmd);
        const truncOutput = output.length > 500 ? output.slice(0, 500) + "..." : output;
        collectedCommands.push(
          `\`${cleanCmd}\` -> exit ${code}${truncOutput ? "\n```\n" + truncOutput + "\n```" : ""}`,
        );
      }

      // Map event to activity and emit to Linear + session progress
      const activity = mapEvent(event);
      if (activity) {
        if (linearApi && agentSessionId) {
          linearApi.emitActivity(agentSessionId, activity).catch((err) => {
            log.warn(`Failed to emit activity: ${err}`);
          });
        }
        progress.push(formatActivityLogLine(activity));
      }
    }

    // --- Finish: resolve the promise ---
    function finish(): void {
      if (resolved) return;
      resolved = true;

      // Stop all watchers and timers
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      watchdog.stop();

      // Final read to catch any trailing output
      readNewBytes();
      // Process any remaining partial line
      if (lineBuffer.trim()) {
        processLine(lineBuffer.trim());
        lineBuffer = "";
      }

      // Unregister session
      unregisterTmuxSession(issueId);

      // Kill the session if it's still alive (defensive cleanup)
      if (sessionExists(sessionName)) {
        killSession(sessionName);
      }

      // Build result
      const parts: string[] = [];
      if (collectedMessages.length > 0) parts.push(collectedMessages.join("\n\n"));
      if (collectedCommands.length > 0) parts.push(collectedCommands.join("\n\n"));
      const output = parts.join("\n\n") || "(no output)";

      if (killed) {
        const errorType = killedByWatchdog ? "inactivity_timeout" : "timeout";
        const reason = killedByWatchdog
          ? `Killed by inactivity watchdog (no I/O for ${Math.round(watchdogMs / 1000)}s)`
          : `Hard timeout after ${Math.round(timeoutMs / 1000)}s`;
        log.warn(`${sessionName}: ${reason}`);
        resolve({
          success: false,
          output: `${reason}. Partial output:\n${output}`,
          error: errorType,
        });
        return;
      }

      if (exitCode !== null && exitCode !== 0) {
        log.warn(`${sessionName}: exited with code ${exitCode}`);
        resolve({
          success: false,
          output: `CLI failed (exit ${exitCode}):\n${output}`,
          error: `exit ${exitCode}`,
        });
        return;
      }

      log.info(`${sessionName}: completed successfully`);
      resolve({ success: true, output });
    }

    // --- Start watching the log file ---
    try {
      watcher = watch(logPath, () => {
        readNewBytes();
      });
      watcher.on("error", () => {
        // Watcher errors are non-fatal — we still have the poll fallback
      });
    } catch {
      // fs.watch() may not be available — poll-only mode
      log.warn(`fs.watch() unavailable for ${logPath}, using poll-only mode`);
    }

    // --- Poll for session death + read any new bytes ---
    // fs.watch() can miss events on some filesystems, so we also poll.
    // Check every 2 seconds: read new bytes + check if session is still alive.
    pollTimer = setInterval(() => {
      readNewBytes();

      // Check if the tmux session has died
      if (!sessionExists(sessionName)) {
        // Give a short grace period for final pipe-pane flush
        setTimeout(() => {
          readNewBytes();
          finish();
        }, 500);
        return;
      }

      // If we already saw the exit marker, check if the session has exited
      if (exitCode !== null) {
        // The CLI command finished — wait briefly for session cleanup
        setTimeout(() => {
          readNewBytes();
          finish();
        }, 1000);
      }
    }, 2000);

    // --- Hard timeout ---
    hardTimer = setTimeout(() => {
      if (resolved) return;
      killed = true;
      log.warn(`${sessionName}: hard timeout (${Math.round(timeoutMs / 1000)}s)`);
      killSession(sessionName);
      // Small delay for final flush
      setTimeout(finish, 500);
    }, timeoutMs);

    // --- Start watchdog ---
    watchdog.start();

    // Initial read (in case the file already has content from session setup)
    readNewBytes();
  });
}

// ---------------------------------------------------------------------------
// recoverOrphanedSessions
// ---------------------------------------------------------------------------

/**
 * Recover or clean up orphaned tmux sessions after a gateway restart.
 *
 * On restart, the in-memory session registry is empty but tmux sessions
 * survive. This function lists all `lnr-*` sessions, checks dispatch
 * state, and either re-registers them or kills stale ones.
 *
 * Call this during plugin onLoad().
 *
 * @param getDispatchState - async function returning current DispatchState
 * @param logger - optional logger
 */
export async function recoverOrphanedSessions(
  getDispatchState: () => Promise<DispatchState>,
  logger?: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<void> {
  const log = logger ?? {
    info: (...a: any[]) => console.log("[tmux-recovery]", ...a),
    warn: (...a: any[]) => console.warn("[tmux-recovery]", ...a),
  };

  const sessions = listSessions("lnr-");
  if (sessions.length === 0) {
    log.info("No orphaned tmux sessions found");
    return;
  }

  log.info(`Found ${sessions.length} lnr-* tmux session(s), checking dispatch state...`);

  let state: DispatchState;
  try {
    state = await getDispatchState();
  } catch (err) {
    log.warn(`Failed to read dispatch state for recovery: ${err}`);
    return;
  }

  const activeDispatches = state.dispatches.active;

  for (const sessionName of sessions) {
    // Parse session name: lnr-{identifier}-{backend}-{attempt}
    const parsed = parseSessionName(sessionName);
    if (!parsed) {
      log.warn(`Cannot parse tmux session name: ${sessionName} — killing`);
      killSession(sessionName);
      continue;
    }

    // Find a matching active dispatch by issueIdentifier
    const dispatch = activeDispatches[parsed.issueIdentifier];
    if (!dispatch) {
      log.warn(
        `No active dispatch for ${parsed.issueIdentifier} — killing tmux session ${sessionName}`,
      );
      killSession(sessionName);
      continue;
    }

    // Dispatch exists — re-register the session so steering tools can find it
    const steeringMode = inferSteeringMode(parsed.backend);
    const info: TmuxSessionInfo = {
      sessionName,
      backend: parsed.backend,
      issueId: dispatch.issueId,
      issueIdentifier: parsed.issueIdentifier,
      startedAt: new Date(dispatch.dispatchedAt).getTime(),
      steeringMode,
    };

    registerTmuxSession(info);
    log.info(
      `Re-registered tmux session ${sessionName} for dispatch ${parsed.issueIdentifier} ` +
      `(${parsed.backend}, ${steeringMode})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a tmux session name created by buildSessionName().
 * Format: lnr-{identifier}-{backend}-{attempt}
 * Example: lnr-UAT-123-claude-0
 *
 * The identifier itself may contain dashes (e.g., UAT-123), so we parse
 * from the right: the last segment is attempt, second-to-last is backend.
 */
function parseSessionName(
  name: string,
): { issueIdentifier: string; backend: string; attempt: number } | null {
  if (!name.startsWith("lnr-")) return null;

  const rest = name.slice(4); // Remove "lnr-" prefix
  const parts = rest.split("-");

  // Need at least 3 parts: identifier(1+), backend(1), attempt(1)
  if (parts.length < 3) return null;

  const attemptStr = parts[parts.length - 1];
  const attempt = parseInt(attemptStr, 10);
  if (isNaN(attempt)) return null;

  const backend = parts[parts.length - 2];
  if (!backend) return null;

  // Everything before backend-attempt is the identifier
  const identifierParts = parts.slice(0, parts.length - 2);
  const issueIdentifier = identifierParts.join("-");
  if (!issueIdentifier) return null;

  return { issueIdentifier, backend, attempt };
}

/**
 * Infer steering mode from the backend name.
 * Claude and Gemini support stdin-pipe steering; Codex is one-shot.
 */
function inferSteeringMode(backend: string): "stdin-pipe" | "one-shot" {
  switch (backend.toLowerCase()) {
    case "claude":
    case "gemini":
      return "stdin-pipe";
    case "codex":
    default:
      return "one-shot";
  }
}

/**
 * Extract backend name from a session name.
 * Falls back to "unknown" if parsing fails.
 */
function extractBackend(sessionName: string): string {
  const parsed = parseSessionName(sessionName);
  return parsed?.backend ?? "unknown";
}
