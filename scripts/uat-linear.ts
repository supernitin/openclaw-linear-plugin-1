#!/usr/bin/env npx tsx
/**
 * uat-linear.ts — Automated UAT runner for the Linear plugin.
 *
 * Creates real test scenarios in a dedicated Linear team, triggers the pipeline
 * via the real webhook path, polls the Linear API for expected outcomes, and
 * reports pass/fail.
 *
 * Prerequisites:
 *   - Gateway running: systemctl --user status openclaw-gateway
 *   - Tunnel active: systemctl --user status cloudflared
 *   - Auth profile: ~/.openclaw/auth-profiles.json with linear:api-key
 *
 * Usage:
 *   npx tsx scripts/uat-linear.ts
 *   npx tsx scripts/uat-linear.ts --test dispatch     # run single test
 *   npx tsx scripts/uat-linear.ts --test planning      # run single test
 */
import { LinearAgentApi, resolveLinearToken } from "../src/api/linear-api.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEAM_ID = "08cba264-d774-4afd-bc93-ee8213d12ef8";
const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures.push(label);
  }
}

const failures: string[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForComment(
  api: LinearAgentApi,
  issueId: string,
  pattern: RegExp,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const details = await api.getIssueDetails(issueId);
      const comments = details.comments?.nodes ?? [];
      for (const comment of comments) {
        if (pattern.test(comment.body)) {
          return comment.body;
        }
      }
    } catch (err) {
      log(`  (poll error: ${err})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function waitForState(
  api: LinearAgentApi,
  issueId: string,
  stateName: string,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const details = await api.getIssueDetails(issueId);
      if (details.state?.name === stateName) return true;
    } catch {}
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Initialize API
// ---------------------------------------------------------------------------

function initApi(): LinearAgentApi {
  const token = resolveLinearToken();
  if (!token.accessToken) {
    console.error("❌ No Linear token found. Check auth-profiles.json.");
    process.exit(1);
  }
  log(`Token source: ${token.source}`);
  return new LinearAgentApi(token.accessToken);
}

// ---------------------------------------------------------------------------
// Test 1: Single Issue Dispatch
// ---------------------------------------------------------------------------

async function testSingleDispatch(api: LinearAgentApi): Promise<void> {
  log("TEST 1: Single Issue Dispatch");
  const tag = `UAT-dispatch-${Date.now()}`;

  // Create test issue
  const issue = await api.createIssue({
    teamId: TEAM_ID,
    title: `${tag}: Implement hello world endpoint`,
    description: `UAT test issue (auto-created). Build a simple hello world HTTP endpoint.\n\nTag: ${tag}`,
    priority: 3,
    estimate: 1,
  });
  log(`  Created issue: ${issue.identifier} (${issue.id})`);

  // Register cleanup
  cleanupFns.push(async () => {
    try {
      await api.updateIssueExtended(issue.id, { assigneeId: null });
      log(`  Cleanup: unassigned ${issue.identifier}`);
    } catch {}
  });

  // Assign to bot (triggers webhook → dispatch)
  const viewerId = await api.getViewerId();
  if (!viewerId) {
    log("  ⚠️  Could not get viewer ID — skipping assignment trigger");
    assert("viewer ID available", false);
    return;
  }

  await api.updateIssueExtended(issue.id, { assigneeId: viewerId });
  log(`  Assigned ${issue.identifier} to bot (viewerId: ${viewerId})`);

  // Wait for dispatch comment
  log("  Waiting for dispatch/worker comment...");
  const dispatchComment = await waitForComment(
    api,
    issue.id,
    /dispatched|worker|implementing|audit/i,
    3 * 60_000,
  );
  assert("dispatch activity detected", dispatchComment !== null);

  if (dispatchComment) {
    log(`  Found comment: ${dispatchComment.slice(0, 100)}...`);
  }

  // Wait for audit result
  log("  Waiting for audit result...");
  const auditComment = await waitForComment(
    api,
    issue.id,
    /audit (passed|failed)|escalating|watchdog/i,
    DEFAULT_TIMEOUT_MS,
  );
  assert("audit completed", auditComment !== null);

  if (auditComment) {
    const passed = /audit passed/i.test(auditComment);
    log(`  Audit result: ${passed ? "PASSED" : "FAILED/STUCK"}`);
    log(`  Comment: ${auditComment.slice(0, 200)}...`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: Planning Flow
// ---------------------------------------------------------------------------

async function testPlanningFlow(api: LinearAgentApi): Promise<void> {
  log("TEST 2: Planning Flow");
  const tag = `UAT-planning-${Date.now()}`;

  // Create root issue
  const rootIssue = await api.createIssue({
    teamId: TEAM_ID,
    title: `${tag}: Plan a search feature`,
    description: `UAT test planning issue (auto-created). Plan out a search feature for the application.\n\nTag: ${tag}`,
    priority: 2,
    estimate: 5,
  });
  log(`  Created root issue: ${rootIssue.identifier} (${rootIssue.id})`);

  cleanupFns.push(async () => {
    try {
      await api.updateIssueExtended(rootIssue.id, { assigneeId: null });
    } catch {}
  });

  // Post a comment mentioning planning
  await api.createComment(rootIssue.id, "@ctclaw plan this project — build a search API with autocomplete");
  log("  Posted planning request comment");

  // Wait for planning mode response
  log("  Waiting for planning mode entry...");
  const planningComment = await waitForComment(
    api,
    rootIssue.id,
    /planning mode|entering planning|feature areas|what.*main/i,
    2 * 60_000,
  );
  assert("planning mode entered", planningComment !== null);

  if (planningComment) {
    log(`  Planning response: ${planningComment.slice(0, 150)}...`);
  }

  // Send a planning input
  await api.createComment(rootIssue.id, "Build a search API endpoint and a results page component");
  log("  Posted planning input");

  // Wait for planner response
  log("  Waiting for planner response...");
  const plannerResponse = await waitForComment(
    api,
    rootIssue.id,
    /search|api|endpoint|component|issue|created/i,
    2 * 60_000,
  );
  assert("planner responded", plannerResponse !== null);

  // Finalize
  await api.createComment(rootIssue.id, "finalize plan");
  log("  Posted finalize request");

  log("  Waiting for plan audit result...");
  const auditResult = await waitForComment(
    api,
    rootIssue.id,
    /plan (approved|audit failed)/i,
    2 * 60_000,
  );
  assert("plan audit completed", auditResult !== null);

  if (auditResult) {
    const approved = /plan approved/i.test(auditResult);
    log(`  Plan audit: ${approved ? "APPROVED" : "FAILED (may need more issues)"}`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: @mention Routing
// ---------------------------------------------------------------------------

async function testMentionRouting(api: LinearAgentApi): Promise<void> {
  log("TEST 3: @mention Routing");
  const tag = `UAT-mention-${Date.now()}`;

  const issue = await api.createIssue({
    teamId: TEAM_ID,
    title: `${tag}: Test mention routing`,
    description: `UAT test for @mention routing (auto-created).\n\nTag: ${tag}`,
    priority: 4,
    estimate: 1,
  });
  log(`  Created issue: ${issue.identifier} (${issue.id})`);

  cleanupFns.push(async () => {
    try {
      await api.updateIssueExtended(issue.id, { assigneeId: null });
    } catch {}
  });

  // Post a comment mentioning Kaylee
  await api.createComment(issue.id, "@kaylee analyze this issue and suggest improvements");
  log("  Posted @kaylee mention");

  log("  Waiting for Kaylee's response...");
  const response = await waitForComment(
    api,
    issue.id,
    /\[kaylee\]|kaylee|analyze|improvement|suggest/i,
    2 * 60_000,
  );
  assert("@kaylee responded", response !== null);

  if (response) {
    log(`  Response: ${response.slice(0, 150)}...`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runCleanup(): Promise<void> {
  log("Running cleanup...");
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch (err) {
      log(`  Cleanup error: ${err}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const singleTest = args.includes("--test") ? args[args.indexOf("--test") + 1] : null;

  console.log("═══════════════════════════════════════════════════");
  console.log("  Linear Plugin UAT — Live Integration Tests");
  console.log("═══════════════════════════════════════════════════\n");

  const api = initApi();

  // Verify connectivity
  try {
    const viewerId = await api.getViewerId();
    log(`Connected to Linear (viewer: ${viewerId})`);
  } catch (err) {
    console.error("❌ Cannot connect to Linear API:", err);
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    if (!singleTest || singleTest === "dispatch") {
      await testSingleDispatch(api);
      console.log();
    }

    if (!singleTest || singleTest === "planning") {
      await testPlanningFlow(api);
      console.log();
    }

    if (!singleTest || singleTest === "mention") {
      await testMentionRouting(api);
      console.log();
    }
  } finally {
    await runCleanup();
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log("\n═══════════════════════════════════════════════════");
  if (failures.length === 0) {
    console.log(`  ✅ ALL TESTS PASSED (${elapsed}s)`);
  } else {
    console.log(`  ❌ ${failures.length} ASSERTION(S) FAILED (${elapsed}s)`);
    for (const f of failures) {
      console.log(`     - ${f}`);
    }
  }
  console.log("═══════════════════════════════════════════════════\n");

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("UAT runner crashed:", err);
  process.exit(2);
});
