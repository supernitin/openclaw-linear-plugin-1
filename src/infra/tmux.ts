import { execFileSync } from "node:child_process";

/**
 * Check if tmux is available on the system.
 */
export function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session with given name.
 * Uses 200x50 terminal size for consistent capture-pane output.
 */
export function createSession(name: string, cwd: string): void {
  execFileSync("tmux", [
    "new-session", "-d", "-s", name, "-x", "200", "-y", "50",
  ], { cwd, encoding: "utf8", timeout: 10_000 });
}

/**
 * Set up pipe-pane to stream terminal output to a file.
 * Filters for JSON lines only (lines starting with "{") to extract JSONL
 * from raw PTY output (which includes ANSI sequences, prompts, etc).
 */
export function setupPipePane(name: string, logPath: string): void {
  execFileSync("tmux", [
    "pipe-pane", "-t", name, "-O",
    `grep --line-buffered "^{" >> ${shellEscapeForTmux(logPath)}`,
  ], { encoding: "utf8", timeout: 5000 });
}

/**
 * Send text to the tmux session's active pane (injects into stdin).
 * Appends Enter key to execute the command.
 */
export function sendKeys(name: string, text: string): void {
  execFileSync("tmux", [
    "send-keys", "-t", name, text, "Enter",
  ], { encoding: "utf8", timeout: 5000 });
}

/**
 * Send raw text without appending Enter (for steering prompts
 * where the Enter should be part of the text itself).
 */
export function sendKeysRaw(name: string, text: string): void {
  execFileSync("tmux", [
    "send-keys", "-t", name, "-l", text,
  ], { encoding: "utf8", timeout: 5000 });
}

/**
 * Capture the visible pane content (ANSI-stripped).
 * Returns the last `lines` lines of the terminal.
 */
export function capturePane(name: string, lines = 50): string {
  return execFileSync("tmux", [
    "capture-pane", "-t", name, "-p", "-S", `-${lines}`,
  ], { encoding: "utf8", timeout: 5000 }).trimEnd();
}

/**
 * Check if a tmux session exists.
 */
export function sessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], {
      encoding: "utf8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session.
 */
export function killSession(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    // Session may already be dead
  }
}

/**
 * List all tmux sessions matching a prefix.
 * Returns session names.
 */
export function listSessions(prefix?: string): string[] {
  try {
    const output = execFileSync("tmux", [
      "list-sessions", "-F", "#{session_name}",
    ], { encoding: "utf8", timeout: 5000 });
    const sessions = output.trim().split("\n").filter(Boolean);
    if (prefix) return sessions.filter(s => s.startsWith(prefix));
    return sessions;
  } catch {
    return [];  // tmux server not running
  }
}

/**
 * Wait for a tmux session to exit (poll-based).
 * Resolves when the session no longer exists or timeout is reached.
 */
export function waitForExit(name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!sessionExists(name) || Date.now() - start > timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

/**
 * Build a tmux session name from dispatch context.
 * Format: lnr-{issueIdentifier}-{backend}-{attempt}
 */
export function buildSessionName(
  issueIdentifier: string,
  backend: string,
  attempt: number,
): string {
  // Sanitize identifier for tmux (replace dots/spaces with dashes)
  const safe = issueIdentifier.replace(/[^a-zA-Z0-9-]/g, "-");
  return `lnr-${safe}-${backend}-${attempt}`;
}

/**
 * Escape a string for safe use in tmux pipe-pane shell commands.
 */
function shellEscapeForTmux(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for safe use as a shell argument in sendKeys.
 * Wraps in single quotes and escapes internal single quotes.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
