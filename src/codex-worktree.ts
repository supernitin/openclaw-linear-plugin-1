import { execFileSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";

const DEFAULT_BASE_REPO = "/home/claw/ai-workspace";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface WorktreeStatus {
  filesChanged: string[];
  hasUncommitted: boolean;
  lastCommit: string | null;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

/**
 * Create a git worktree for isolated Codex work.
 * Branch: codex/{issueIdentifier}
 * Path: /tmp/codex-{issueIdentifier}-{timestamp}
 */
export function createWorktree(
  issueIdentifier: string,
  baseRepo?: string,
): WorktreeInfo {
  const repo = baseRepo ?? DEFAULT_BASE_REPO;
  if (!existsSync(repo)) {
    throw new Error(`Base repo not found: ${repo}`);
  }

  const branch = `codex/${issueIdentifier}`;
  const ts = Date.now();
  const worktreePath = `/tmp/codex-${issueIdentifier}-${ts}`;

  // Ensure we're on a clean base — fetch latest
  try {
    git(["fetch", "origin"], repo);
  } catch {
    // Offline or no remote — continue with local state
  }

  // Delete stale branch if it exists (from a previous run)
  try {
    git(["branch", "-D", branch], repo);
  } catch {
    // Branch doesn't exist — fine
  }

  // Create worktree with new branch off HEAD
  git(["worktree", "add", "-b", branch, worktreePath], repo);

  return { path: worktreePath, branch };
}

/**
 * Get the status of a worktree: changed files, uncommitted work, last commit.
 */
export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  if (!existsSync(worktreePath)) {
    return { filesChanged: [], hasUncommitted: false, lastCommit: null };
  }

  const diffOutput = git(
    ["diff", "--name-only", "HEAD"],
    worktreePath,
  );
  const stagedOutput = git(
    ["diff", "--name-only", "--cached"],
    worktreePath,
  );
  const untrackedOutput = git(
    ["ls-files", "--others", "--exclude-standard"],
    worktreePath,
  );

  const allFiles = new Set<string>();
  for (const line of [...diffOutput.split("\n"), ...stagedOutput.split("\n"), ...untrackedOutput.split("\n")]) {
    const trimmed = line.trim();
    if (trimmed) allFiles.add(trimmed);
  }

  const hasUncommitted = allFiles.size > 0;

  let lastCommit: string | null = null;
  try {
    lastCommit = git(["log", "-1", "--oneline"], worktreePath);
  } catch {
    // No commits yet
  }

  return {
    filesChanged: [...allFiles],
    hasUncommitted,
    lastCommit,
  };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export function removeWorktree(
  worktreePath: string,
  opts?: { deleteBranch?: boolean; baseRepo?: string },
): void {
  const repo = opts?.baseRepo ?? DEFAULT_BASE_REPO;

  if (existsSync(worktreePath)) {
    git(["worktree", "remove", "--force", worktreePath], repo);
  }

  if (opts?.deleteBranch) {
    // Extract branch name from the worktree path convention
    try {
      const branches = git(["branch", "--list", "codex/*"], repo);
      // Only delete if it looks like a codex branch
      for (const b of branches.split("\n")) {
        const name = b.trim().replace(/^\* /, "");
        if (name && worktreePath.includes(name.replace("codex/", ""))) {
          git(["branch", "-D", name], repo);
          break;
        }
      }
    } catch {
      // Best effort
    }
  }
}

/**
 * Push the worktree branch and create a GitHub PR via `gh`.
 */
export function createPullRequest(
  worktreePath: string,
  title: string,
  body: string,
): { prUrl: string } {
  // Commit any uncommitted changes first
  const status = getWorktreeStatus(worktreePath);
  if (status.hasUncommitted) {
    git(["add", "-A"], worktreePath);
    git(
      [
        "-c", "user.name=claw",
        "-c", "user.email=claw@calltelemetry.com",
        "commit", "-m", title,
      ],
      worktreePath,
    );
  }

  // Get branch name
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);

  // Push branch
  git(["push", "-u", "origin", branch], worktreePath);

  // Create PR via gh CLI
  const prUrl = execFileSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--head", branch],
    { cwd: worktreePath, encoding: "utf8", timeout: 30_000 },
  ).trim();

  return { prUrl };
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  ageMs: number;
  hasChanges: boolean;
}

/**
 * List all codex worktrees under /tmp.
 */
export function listWorktrees(baseRepo?: string): WorktreeEntry[] {
  const repo = baseRepo ?? DEFAULT_BASE_REPO;
  const entries: WorktreeEntry[] = [];

  // Find /tmp/codex-* directories
  let dirs: string[];
  try {
    dirs = readdirSync("/tmp")
      .filter((d) => d.startsWith("codex-"))
      .map((d) => `/tmp/${d}`);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;

      let branch = "unknown";
      try {
        branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
      } catch {}

      let hasChanges = false;
      try {
        const status = getWorktreeStatus(dir);
        hasChanges = status.hasUncommitted;
      } catch {}

      entries.push({
        path: dir,
        branch,
        ageMs: Date.now() - stat.mtimeMs,
        hasChanges,
      });
    } catch {
      // Skip unreadable dirs
    }
  }

  return entries.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * Remove codex worktrees older than maxAgeMs.
 * Returns list of removed paths.
 */
export function pruneStaleWorktrees(
  maxAgeMs: number = 24 * 60 * 60_000,
  opts?: { baseRepo?: string; dryRun?: boolean },
): { removed: string[]; skipped: string[]; errors: string[] } {
  const repo = opts?.baseRepo ?? DEFAULT_BASE_REPO;
  const worktrees = listWorktrees(repo);
  const removed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const wt of worktrees) {
    if (wt.ageMs < maxAgeMs) {
      skipped.push(wt.path);
      continue;
    }

    if (opts?.dryRun) {
      removed.push(wt.path);
      continue;
    }

    try {
      removeWorktree(wt.path, { deleteBranch: true, baseRepo: repo });
      removed.push(wt.path);
    } catch (err) {
      errors.push(`${wt.path}: ${err}`);
    }
  }

  return { removed, skipped, errors };
}
