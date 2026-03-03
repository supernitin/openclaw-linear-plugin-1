/**
 * Lightweight triage hook for Linear entities.
 *
 * Runs fast structural checks on new/updated issues without spawning
 * a full agent session. Checks: project assignment, duplicate detection,
 * alignment with project scope, missing info, and formatting.
 *
 * Also stores a semantic summary in mem0 for agent recall.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi } from "../api/linear-api.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TriageInput {
  /** The issue or entity data from the webhook payload */
  issue: {
    id: string;
    identifier?: string;
    title?: string;
    description?: string;
    creatorId?: string;
    team?: { id: string; name?: string; key?: string };
    project?: { id: string; name?: string; description?: string };
    labels?: { nodes: Array<{ id: string; name: string }> };
    state?: { name: string; type: string };
    parent?: { id: string; identifier: string; title?: string };
  };
  /** Enriched issue data (fetched separately if not in webhook payload) */
  enrichedIssue?: any;
}

export interface TriageResult {
  /** Whether triage ran successfully */
  success: boolean;
  /** Checks that were performed and their outcomes */
  checks: TriageCheck[];
  /** Actions taken */
  actions: TriageAction[];
  /** Comment ID if a triage comment was posted */
  commentId?: string;
  /** Elapsed time in ms */
  elapsedMs: number;
}

export interface TriageCheck {
  name: string;
  status: "pass" | "flag" | "skip";
  detail?: string;
}

export interface TriageAction {
  type: "set_project" | "post_comment" | "add_emoji" | "store_mem0" | "flag_duplicate" | "flag_alignment";
  detail: string;
}

// ── Config ───────────────────────────────────────────────────────────

interface TriageConfig {
  /** Disable the entire lightweight triage hook */
  enabled: boolean;
  /** Confidence threshold for duplicate detection (0-1) */
  duplicateThreshold: number;
  /** Maximum sibling issues to compare for duplicates */
  maxSiblingCompare: number;
  /** Whether to auto-set project when missing */
  autoSetProject: boolean;
  /** Whether to store entity summaries in mem0 */
  storeMem0: boolean;
  /** Label name to add as "triaged" indicator */
  triageLabel?: string;
}

function resolveTriageConfig(pluginConfig?: Record<string, unknown>): TriageConfig {
  const triage = (pluginConfig?.lightweightTriage ?? {}) as Record<string, unknown>;
  return {
    enabled: triage.enabled !== false,
    duplicateThreshold: (triage.duplicateThreshold as number) ?? 0.7,
    maxSiblingCompare: (triage.maxSiblingCompare as number) ?? 30,
    autoSetProject: triage.autoSetProject !== false,
    storeMem0: triage.storeMem0 !== false,
    triageLabel: (triage.triageLabel as string) ?? undefined,
  };
}

// ── Core triage function ─────────────────────────────────────────────

export async function runLightweightTriage(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  input: TriageInput,
  pluginConfig?: Record<string, unknown>,
): Promise<TriageResult> {
  const start = Date.now();
  const config = resolveTriageConfig(pluginConfig);
  const checks: TriageCheck[] = [];
  const actions: TriageAction[] = [];

  if (!config.enabled) {
    return { success: true, checks: [], actions: [], elapsedMs: Date.now() - start };
  }

  const issue = input.issue;
  const issueRef = issue.identifier ?? issue.id;

  api.logger.info(`lightweight-triage: starting for ${issueRef}`);

  // ── Step 1: Fetch context in parallel ─────────────────────────────

  let enrichedIssue = input.enrichedIssue;
  let projectDetails: { id: string; name: string; description: string; state: string } | null = null;
  let siblingIssues: Array<{ id: string; identifier: string; title: string; description: string | null; state: { name: string } }> = [];
  let teamProjects: Array<{ id: string; name: string; description: string | null; state: string }> = [];
  let initiatives: Array<{ id: string; name: string; description: string | null; status: string }> = [];

  try {
    const fetchPromises: Promise<void>[] = [];

    // Fetch enriched issue if not provided
    if (!enrichedIssue) {
      fetchPromises.push(
        linearApi.getIssueDetails(issue.id).then((d) => { enrichedIssue = d; }).catch(() => {}),
      );
    }

    // Fetch project details + siblings if issue has a project
    const projectId = issue.project?.id ?? enrichedIssue?.project?.id;
    if (projectId) {
      fetchPromises.push(
        linearApi.getProject(projectId).then((p) => { projectDetails = p; }).catch(() => {}),
      );
      fetchPromises.push(
        linearApi.getProjectIssues(projectId).then((issues) => {
          siblingIssues = issues
            .filter((i: any) => i.id !== issue.id)
            .slice(0, config.maxSiblingCompare);
        }).catch(() => {}),
      );
      fetchPromises.push(
        linearApi.getInitiativesForProject(projectId).then((i) => { initiatives = i; }).catch(() => {}),
      );
    }

    // Fetch team projects if no project assigned (for auto-suggestion)
    const teamId = issue.team?.id ?? enrichedIssue?.team?.id;
    if (!projectId && teamId && config.autoSetProject) {
      fetchPromises.push(
        linearApi.getTeamProjects(teamId).then((p) => {
          teamProjects = p.filter((proj) => proj.state === "started" || proj.state === "planned");
        }).catch(() => {}),
      );
    }

    await Promise.all(fetchPromises);

    // Second pass: if enriched issue now has a project, fetch its data
    const resolvedProjectId = projectId ?? enrichedIssue?.project?.id;
    if (resolvedProjectId && !projectDetails) {
      try {
        projectDetails = await linearApi.getProject(resolvedProjectId);
        if (siblingIssues.length === 0) {
          const issues = await linearApi.getProjectIssues(resolvedProjectId);
          siblingIssues = issues
            .filter((i: any) => i.id !== issue.id)
            .slice(0, config.maxSiblingCompare);
        }
      } catch {}
    }
  } catch (err) {
    api.logger.warn(`lightweight-triage: context fetch failed: ${err}`);
  }

  const title = enrichedIssue?.title ?? issue.title ?? "(untitled)";
  const description = enrichedIssue?.description ?? issue.description ?? "";

  // ── Step 2: Run checks ─────────────────────────────────────────────

  // Check 1: Project assignment
  const hasProject = !!(enrichedIssue?.project?.id ?? issue.project?.id);
  if (!hasProject) {
    if (teamProjects.length > 0) {
      // Find best-matching project by comparing title/description
      const bestMatch = findBestProjectMatch(title, description, teamProjects);
      if (bestMatch) {
        checks.push({
          name: "project_assignment",
          status: "flag",
          detail: `No project set. Suggested: **${bestMatch.name}** — ${bestMatch.reason}`,
        });
        if (config.autoSetProject && bestMatch.confidence > 0.6) {
          try {
            await linearApi.updateIssueExtended(issue.id, { projectId: bestMatch.id });
            actions.push({ type: "set_project", detail: `Set project to "${bestMatch.name}"` });
            checks[checks.length - 1].status = "pass";
            checks[checks.length - 1].detail = `Auto-assigned to project **${bestMatch.name}** — ${bestMatch.reason}`;
          } catch (err) {
            api.logger.warn(`lightweight-triage: failed to set project: ${err}`);
          }
        }
      } else {
        checks.push({
          name: "project_assignment",
          status: "flag",
          detail: `No project set. ${teamProjects.length} active projects available but none matched well.`,
        });
      }
    } else {
      checks.push({ name: "project_assignment", status: "flag", detail: "No project set and no active projects found for team." });
    }
  } else {
    checks.push({ name: "project_assignment", status: "pass" });
  }

  // Check 2: Duplicate detection
  if (siblingIssues.length > 0) {
    const duplicate = findDuplicate(title, description, siblingIssues, config.duplicateThreshold);
    if (duplicate) {
      checks.push({
        name: "duplicate_check",
        status: "flag",
        detail: `Possible duplicate of **${duplicate.identifier}**: "${duplicate.title}" (similarity: ${(duplicate.similarity * 100).toFixed(0)}%)`,
      });
      actions.push({
        type: "flag_duplicate",
        detail: `Similar to ${duplicate.identifier} — consider merging`,
      });
    } else {
      checks.push({ name: "duplicate_check", status: "pass" });
    }
  } else {
    checks.push({ name: "duplicate_check", status: "skip", detail: "No sibling issues to compare" });
  }

  // Check 3: Project alignment
  if (projectDetails && projectDetails.description) {
    const aligned = checkAlignment(title, description, projectDetails);
    if (!aligned.isAligned) {
      checks.push({
        name: "project_alignment",
        status: "flag",
        detail: aligned.reason,
      });
      actions.push({ type: "flag_alignment", detail: aligned.reason });
    } else {
      checks.push({ name: "project_alignment", status: "pass" });
    }
  } else {
    checks.push({ name: "project_alignment", status: "skip", detail: "No project description to check against" });
  }

  // Check 4: Missing information
  const missingInfo = detectMissingInfo(title, description, enrichedIssue);
  if (missingInfo.length > 0) {
    checks.push({
      name: "completeness",
      status: "flag",
      detail: `Missing: ${missingInfo.join(", ")}`,
    });
  } else {
    checks.push({ name: "completeness", status: "pass" });
  }

  // Check 5: Formatting
  const formatIssues = checkFormatting(title, description);
  if (formatIssues.length > 0) {
    checks.push({
      name: "formatting",
      status: "flag",
      detail: formatIssues.join("; "),
    });
  } else {
    checks.push({ name: "formatting", status: "pass" });
  }

  // ── Step 3: Post consolidated comment ──────────────────────────────

  const flags = checks.filter((c) => c.status === "flag");
  let commentId: string | undefined;

  if (flags.length > 0) {
    const commentLines = [
      `**Triage** ${flags.length === 0 ? "✅" : "⚠️"} ${flags.length} item${flags.length !== 1 ? "s" : ""} flagged`,
      "",
    ];
    for (const check of checks) {
      if (check.status === "flag") {
        commentLines.push(`- ⚠️ **${formatCheckName(check.name)}:** ${check.detail}`);
      }
    }
    // Add pass summary
    const passes = checks.filter((c) => c.status === "pass").length;
    if (passes > 0) {
      commentLines.push(`- ✅ ${passes} check${passes !== 1 ? "s" : ""} passed`);
    }

    try {
      commentId = await linearApi.createComment(issue.id, commentLines.join("\n"));
      actions.push({ type: "post_comment", detail: "Triage summary posted" });

      // Add emoji reaction to the comment
      if (commentId) {
        await linearApi.createReaction(commentId, flags.length > 0 ? "⚠️" : "✅").catch(() => {});
        actions.push({ type: "add_emoji", detail: flags.length > 0 ? "⚠️" : "✅" });
      }
    } catch (err) {
      api.logger.warn(`lightweight-triage: failed to post comment: ${err}`);
    }
  } else {
    api.logger.info(`lightweight-triage: ${issueRef} — all checks passed, no comment needed`);
  }

  // ── Step 4: Store in mem0 ──────────────────────────────────────────

  if (config.storeMem0) {
    try {
      await storeEntityInMem0(api, "issue", {
        identifier: issueRef,
        title,
        description: description.slice(0, 500),
        project: projectDetails?.name ?? enrichedIssue?.project?.name,
        state: enrichedIssue?.state?.name,
        labels: enrichedIssue?.labels?.nodes?.map((l: any) => l.name) ?? [],
        triageFlags: flags.map((f) => f.name),
      });
      actions.push({ type: "store_mem0", detail: "Entity summary stored in mem0" });
    } catch (err) {
      api.logger.warn(`lightweight-triage: mem0 store failed: ${err}`);
    }
  }

  const elapsed = Date.now() - start;
  api.logger.info(
    `lightweight-triage: ${issueRef} completed in ${elapsed}ms — ${checks.length} checks, ${flags.length} flags, ${actions.length} actions`,
  );

  return { success: true, checks, actions, commentId, elapsedMs: elapsed };
}

// ── Entity mem0 storage (for all webhook types) ──────────────────────

export async function storeEntityInMem0(
  api: OpenClawPluginApi,
  entityType: string,
  entity: Record<string, unknown>,
): Promise<void> {
  // Build a one-line semantic summary
  const parts: string[] = [`[${entityType}]`];
  if (entity.identifier) parts.push(String(entity.identifier));
  if (entity.title) parts.push(`"${String(entity.title).slice(0, 100)}"`);
  if (entity.project) parts.push(`project: ${entity.project}`);
  if (entity.state) parts.push(`state: ${entity.state}`);
  if (Array.isArray(entity.labels) && entity.labels.length > 0) {
    parts.push(`labels: ${entity.labels.join(", ")}`);
  }
  const summary = parts.join(" | ");

  // Use the plugin API's memory slot if available
  const runtime = (api as any).runtime;
  if (runtime?.memory?.add) {
    try {
      await runtime.memory.add(summary, { source: `linear-${entityType}` });
      return;
    } catch {
      // Fall through to direct approach
    }
  }

  // Fallback: call the mem0 plugin's tool directly if registered
  const tools = (api as any).tools;
  if (tools?.call) {
    try {
      await tools.call("memory_add", { content: summary, metadata: { source: `linear-${entityType}` } });
      return;
    } catch {
      // Fall through
    }
  }

  // Last resort: log the summary (mem0 auto-capture might pick it up from agent context)
  api.logger.info(`lightweight-triage mem0: ${summary}`);
}

// ── Lightweight analysis functions (no LLM needed) ───────────────────

function findBestProjectMatch(
  title: string,
  description: string,
  projects: Array<{ id: string; name: string; description: string | null; state: string }>,
): { id: string; name: string; reason: string; confidence: number } | null {
  const text = `${title} ${description}`.toLowerCase();
  let bestMatch: { id: string; name: string; reason: string; confidence: number } | null = null;

  for (const project of projects) {
    const projectText = `${project.name} ${project.description ?? ""}`.toLowerCase();
    const score = computeWordOverlap(text, projectText);
    if (score > (bestMatch?.confidence ?? 0)) {
      bestMatch = {
        id: project.id,
        name: project.name,
        reason: `Title/description shares keywords with project "${project.name}"`,
        confidence: score,
      };
    }
  }

  return bestMatch && bestMatch.confidence > 0.3 ? bestMatch : null;
}

function findDuplicate(
  title: string,
  description: string,
  siblings: Array<{ id: string; identifier: string; title: string; description: string | null; state: { name: string } }>,
  threshold: number,
): { identifier: string; title: string; similarity: number } | null {
  const titleLower = title.toLowerCase().trim();
  const descLower = description.toLowerCase().trim();
  let bestMatch: { identifier: string; title: string; similarity: number } | null = null;

  for (const sibling of siblings) {
    // Skip completed/cancelled issues
    const stateType = (sibling.state as any)?.type ?? "";
    if (stateType === "completed" || stateType === "canceled") continue;

    const sibTitleLower = sibling.title.toLowerCase().trim();
    const sibDescLower = (sibling.description ?? "").toLowerCase().trim();

    // Title similarity (weighted higher)
    const titleSim = computeStringSimilarity(titleLower, sibTitleLower);

    // Description similarity (if both have descriptions)
    let descSim = 0;
    if (descLower.length > 20 && sibDescLower.length > 20) {
      descSim = computeWordOverlap(descLower, sibDescLower);
    }

    // Combined score: title similarity is primary
    const combined = titleSim * 0.6 + descSim * 0.4;

    if (combined > (bestMatch?.similarity ?? 0)) {
      bestMatch = { identifier: sibling.identifier, title: sibling.title, similarity: combined };
    }
  }

  return bestMatch && bestMatch.similarity >= threshold ? bestMatch : null;
}

function checkAlignment(
  title: string,
  description: string,
  project: { name: string; description: string },
): { isAligned: boolean; reason: string } {
  const issueText = `${title} ${description}`.toLowerCase();
  const projectText = `${project.name} ${project.description}`.toLowerCase();
  const overlap = computeWordOverlap(issueText, projectText);

  // Very low overlap might indicate misalignment
  if (overlap < 0.05 && description.length > 50) {
    return {
      isAligned: false,
      reason: `Issue appears unrelated to project "${project.name}" — very low keyword overlap. Consider moving to a different project.`,
    };
  }
  return { isAligned: true, reason: "" };
}

function detectMissingInfo(
  title: string,
  description: string,
  enrichedIssue: any,
): string[] {
  const missing: string[] = [];

  // No description at all
  if (!description || description.trim().length < 10) {
    missing.push("description (issue has no meaningful description)");
  }

  // Title is very short or generic
  if (title.length < 10) {
    missing.push("detailed title (current title is very short)");
  }

  // No priority set (0 = no priority in Linear)
  if (enrichedIssue?.priority === 0) {
    missing.push("priority");
  }

  // No labels
  if (!enrichedIssue?.labels?.nodes?.length) {
    missing.push("labels");
  }

  return missing;
}

function checkFormatting(title: string, description: string): string[] {
  const issues: string[] = [];

  // Title starts with lowercase
  if (title && /^[a-z]/.test(title)) {
    issues.push("Title starts with lowercase letter");
  }

  // Title ends with period
  if (title && title.trim().endsWith(".")) {
    issues.push("Title ends with period (not standard for issue titles)");
  }

  // Title is ALL CAPS
  if (title && title === title.toUpperCase() && title.length > 5) {
    issues.push("Title is ALL CAPS");
  }

  // Description has no structure (long wall of text without line breaks)
  if (description && description.length > 500 && !description.includes("\n")) {
    issues.push("Description is a long wall of text without line breaks — consider adding structure");
  }

  return issues;
}

// ── String similarity utilities ──────────────────────────────────────

function computeWordOverlap(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  // Jaccard similarity
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}

function computeStringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Bigram similarity (Dice coefficient)
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

function getBigrams(str: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.slice(i, i + 2));
  }
  return bigrams;
}

// Stop words to filter out of keyword comparisons
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "and", "but", "or", "nor",
  "not", "so", "yet", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "only", "own", "same", "than", "too", "very",
  "just", "because", "about", "up", "it", "its", "this", "that", "these",
  "those", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "they", "them", "their", "what", "which", "who", "whom", "where",
  "when", "why", "how", "all", "any", "if", "also", "need", "needs",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function formatCheckName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
