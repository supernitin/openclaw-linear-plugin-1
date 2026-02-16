import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi, ActivityContent } from "./linear-api.js";
import { runAgent } from "./agent.js";

export interface PipelineContext {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  agentSessionId: string;
  agentId: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
  };
  promptContext?: unknown;
}

function emit(ctx: PipelineContext, content: ActivityContent): Promise<void> {
  return ctx.linearApi.emitActivity(ctx.agentSessionId, content).catch((err) => {
    ctx.api.logger.error(`Failed to emit activity: ${err}`);
  });
}

// ── Stage 1: Planner ───────────────────────────────────────────────

export async function runPlannerStage(ctx: PipelineContext): Promise<string | null> {
  await emit(ctx, { type: "thought", body: `Analyzing issue ${ctx.issue.identifier}...` });

  const issueDetails = await ctx.linearApi.getIssueDetails(ctx.issue.id).catch(() => null);

  const description = issueDetails?.description ?? ctx.issue.description ?? "(no description)";
  const comments = issueDetails?.comments?.nodes ?? [];
  const commentSummary = comments
    .slice(-5)
    .map((c) => `${c.user?.name ?? "Unknown"}: ${c.body}`)
    .join("\n");

  const message = `You are a planner agent. Analyze this Linear issue and create an implementation plan.

## Issue: ${ctx.issue.identifier} — ${ctx.issue.title}

**Description:**
${description}

${commentSummary ? `**Recent comments:**\n${commentSummary}` : ""}

${ctx.promptContext ? `**Additional context:**\n${JSON.stringify(ctx.promptContext)}` : ""}

## Instructions
1. Analyze the issue thoroughly
2. Break it into concrete implementation steps
3. Identify files that need to change
4. Note any risks or dependencies
5. Output your plan in markdown format

Output ONLY the plan, nothing else.`;

  await emit(ctx, { type: "action", action: "Planning", parameter: ctx.issue.identifier });

  const result = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId: `linear-plan-${ctx.agentSessionId}`,
    message,
    timeoutMs: 5 * 60_000,
  });

  if (!result.success) {
    await emit(ctx, { type: "error", body: `Planning failed: ${result.output.slice(0, 500)}` });
    return null;
  }

  const plan = result.output;

  // Post plan as a Linear comment
  await ctx.linearApi.createComment(
    ctx.issue.id,
    `## Implementation Plan\n\n${plan}\n\n---\n*Reply to this comment to approve the plan and begin implementation.*`,
  );

  await emit(ctx, {
    type: "elicitation",
    body: "I've posted an implementation plan as a comment. Please review and reply to approve.",
  });

  return plan;
}

// ── Stage 2: Implementor ──────────────────────────────────────────

export async function runImplementorStage(
  ctx: PipelineContext,
  plan: string,
): Promise<string | null> {
  await emit(ctx, { type: "thought", body: "Plan approved. Starting implementation..." });

  const message = `You are an implementor agent. Execute this plan for issue ${ctx.issue.identifier}.

## Issue: ${ctx.issue.identifier} — ${ctx.issue.title}

## Approved Plan:
${plan}

## Instructions
1. Follow the plan step by step
2. Write the code changes
3. Create commits for each logical change
4. If the plan involves creating a PR, do so
5. Report what you did and any files changed

Be thorough but stay within scope of the plan.`;

  await emit(ctx, { type: "action", action: "Implementing", parameter: ctx.issue.identifier });

  const result = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId: `linear-impl-${ctx.agentSessionId}`,
    message,
    timeoutMs: 10 * 60_000,
  });

  if (!result.success) {
    await emit(ctx, { type: "error", body: `Implementation failed: ${result.output.slice(0, 500)}` });
    return null;
  }

  await emit(ctx, { type: "action", action: "Implementation complete", result: "Proceeding to audit" });
  return result.output;
}

// ── Stage 3: Auditor ──────────────────────────────────────────────

export async function runAuditorStage(
  ctx: PipelineContext,
  plan: string,
  implResult: string,
): Promise<void> {
  await emit(ctx, { type: "thought", body: "Auditing implementation against the plan..." });

  const message = `You are an auditor. Review this implementation against the original plan.

## Issue: ${ctx.issue.identifier} — ${ctx.issue.title}

## Original Plan:
${plan}

## Implementation Result:
${implResult}

## Instructions
1. Verify each plan step was completed
2. Check for any missed items
3. Note any concerns or improvements needed
4. Provide a pass/fail verdict with reasoning
5. Output a concise audit summary in markdown

Output ONLY the audit summary.`;

  await emit(ctx, { type: "action", action: "Auditing", parameter: ctx.issue.identifier });

  const result = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId: `linear-audit-${ctx.agentSessionId}`,
    message,
    timeoutMs: 5 * 60_000,
  });

  const auditSummary = result.success ? result.output : `Audit failed: ${result.output.slice(0, 500)}`;

  await ctx.linearApi.createComment(
    ctx.issue.id,
    `## Audit Report\n\n${auditSummary}`,
  );

  await emit(ctx, {
    type: "response",
    body: `Completed work on ${ctx.issue.identifier}. Plan, implementation, and audit posted as comments.`,
  });
}

// ── Full Pipeline ─────────────────────────────────────────────────

export async function runFullPipeline(ctx: PipelineContext): Promise<void> {
  try {
    // Stage 1: Plan
    const plan = await runPlannerStage(ctx);
    if (!plan) return;

    // Pipeline pauses here — user must reply to approve.
    // The "prompted" webhook will call resumePipeline().
  } catch (err) {
    ctx.api.logger.error(`Pipeline error: ${err}`);
    await emit(ctx, { type: "error", body: `Pipeline failed: ${String(err).slice(0, 500)}` });
  }
}

export async function resumePipeline(ctx: PipelineContext, plan: string): Promise<void> {
  try {
    // Stage 2: Implement
    const implResult = await runImplementorStage(ctx, plan);
    if (!implResult) return;

    // Stage 3: Audit
    await runAuditorStage(ctx, plan, implResult);
  } catch (err) {
    ctx.api.logger.error(`Pipeline error: ${err}`);
    await emit(ctx, { type: "error", body: `Pipeline failed: ${String(err).slice(0, 500)}` });
  }
}
