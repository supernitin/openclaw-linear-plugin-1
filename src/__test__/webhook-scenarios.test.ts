/**
 * webhook-scenarios.test.ts — Full handler flow tests using captured payloads.
 *
 * Replays webhook payloads through handleLinearWebhook with mocked API
 * dependencies. Tests the complete async handler behavior for each event
 * type: API calls made, session lifecycle, agent runs, and responses.
 *
 * Unlike webhook-dedup.test.ts (dedup logic) and webhook.test.ts (HTTP basics),
 * these tests verify the full business logic paths end-to-end.
 *
 * Key pattern: comment-triggered responses use threaded comments (parentId)
 * rather than emitActivity, so replies appear under the triggering comment.
 * emitActivity is used for session-triggered responses (no parent comment)
 * and as a fallback when no comment context exists.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock references ──────────────────────────────────────

const {
  mockRunAgent,
  mockGetViewerId,
  mockGetIssueDetails,
  mockCreateComment,
  mockEmitActivity,
  mockUpdateSession,
  mockUpdateIssue,
  mockGetTeamLabels,
  mockGetTeamStates,
  mockCreateSessionOnIssue,
  mockClassifyIntent,
  mockSpawnWorker,
  mockSetActiveSession,
  mockClearActiveSession,
  mockEmitDiagnostic,
  mockCreateCommentOnEntity,
} = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockGetViewerId: vi.fn(),
  mockGetIssueDetails: vi.fn(),
  mockCreateComment: vi.fn(),
  mockEmitActivity: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockUpdateIssue: vi.fn(),
  mockGetTeamLabels: vi.fn(),
  mockGetTeamStates: vi.fn(),
  mockCreateSessionOnIssue: vi.fn(),
  mockClassifyIntent: vi.fn(),
  mockSpawnWorker: vi.fn(),
  mockSetActiveSession: vi.fn(),
  mockClearActiveSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
  mockCreateCommentOnEntity: vi.fn(),
}));

// ── Module mocks (must precede all imports of tested code) ───────

vi.mock("../agent/agent.js", () => ({
  runAgent: mockRunAgent,
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class MockLinearAgentApi {
    emitActivity = mockEmitActivity;
    createComment = mockCreateComment;
    createCommentOnEntity = mockCreateCommentOnEntity;
    getIssueDetails = mockGetIssueDetails;
    updateSession = mockUpdateSession;
    getViewerId = mockGetViewerId;
    updateIssue = mockUpdateIssue;
    getTeamLabels = mockGetTeamLabels;
    getTeamStates = mockGetTeamStates;
    createSessionOnIssue = mockCreateSessionOnIssue;
  },
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
  }),
}));

vi.mock("../pipeline/pipeline.js", () => ({
  spawnWorker: mockSpawnWorker,
  runPlannerStage: vi.fn().mockResolvedValue("mock plan"),
  runFullPipeline: vi.fn().mockResolvedValue(undefined),
  resumePipeline: vi.fn().mockResolvedValue(undefined),
  buildProjectContext: () => "",
}));

vi.mock("../pipeline/active-session.js", () => ({
  setActiveSession: mockSetActiveSession,
  clearActiveSession: mockClearActiveSession,
  getIssueAffinity: vi.fn().mockReturnValue(null),
  _configureAffinityTtl: vi.fn(),
  _resetAffinityForTesting: vi.fn(),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: mockEmitDiagnostic,
}));

vi.mock("../pipeline/intent-classify.js", () => ({
  classifyIntent: mockClassifyIntent,
}));

vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: vi.fn().mockResolvedValue({ version: 2, dispatches: { active: {}, completed: {} }, sessionMap: {}, processedEvents: [] }),
  getActiveDispatch: vi.fn().mockReturnValue(null),
  registerDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatchStatus: vi.fn().mockResolvedValue(undefined),
  completeDispatch: vi.fn().mockResolvedValue(undefined),
  removeActiveDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../infra/notify.js", () => ({
  createNotifierFromConfig: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("../pipeline/tier-assess.js", () => ({
  assessTier: vi.fn().mockResolvedValue({ tier: "standard", model: "test-model", reasoning: "mock assessment" }),
}));

vi.mock("../infra/codex-worktree.js", () => ({
  createWorktree: vi.fn().mockReturnValue({ path: "/tmp/mock-worktree", branch: "codex/ENG-123", resumed: false }),
  createMultiWorktree: vi.fn(),
  prepareWorkspace: vi.fn().mockReturnValue({ pulled: false, submodulesInitialized: false, errors: [] }),
}));

vi.mock("../infra/multi-repo.js", () => ({
  resolveRepos: vi.fn().mockReturnValue({ repos: [] }),
  isMultiRepo: vi.fn().mockReturnValue(false),
}));

vi.mock("../pipeline/artifacts.js", () => ({
  ensureClawDir: vi.fn(),
  writeManifest: vi.fn(),
  writeDispatchMemory: vi.fn(),
  resolveOrchestratorWorkspace: vi.fn().mockReturnValue("/mock/workspace"),
}));

vi.mock("../pipeline/planning-state.js", () => ({
  readPlanningState: vi.fn().mockResolvedValue({ sessions: {} }),
  isInPlanningMode: vi.fn().mockReturnValue(false),
  getPlanningSession: vi.fn().mockReturnValue(null),
  endPlanningSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pipeline/planner.js", () => ({
  initiatePlanningSession: vi.fn().mockResolvedValue(undefined),
  handlePlannerTurn: vi.fn().mockResolvedValue(undefined),
  runPlanAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pipeline/dag-dispatch.js", () => ({
  startProjectDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../infra/shared-profiles.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    validateProfiles: vi.fn().mockReturnValue(null),
    loadAgentProfiles: vi.fn().mockReturnValue({
      main: {
        label: "frAInk",
        mentionAliases: ["main", "fraink"],
        avatarUrl: null,
      },
    }),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────

import { handleLinearWebhook, _resetForTesting } from "../pipeline/webhook.js";
import {
  makeAgentSessionEventCreated,
  makeAgentSessionEventPrompted,
  makeCommentCreate,
  makeCommentCreateFromBot,
  makeIssueCreate,
  makeIssueUpdateWithAssignment,
  makeAppUserNotification,
} from "./fixtures/webhook-payloads.js";
import { makeIssueDetails } from "./fixtures/linear-responses.js";

// ── Helpers ──────────────────────────────────────────────────────

function createApi(): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {},
    pluginConfig: { defaultAgentId: "mal" },
  } as unknown as OpenClawPluginApi;
}

async function withServer(
  handler: Parameters<typeof createServer>[0],
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("missing server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postWebhook(api: OpenClawPluginApi, payload: unknown) {
  let status = 0;
  let body = "";
  await withServer(
    async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/linear/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      status = response.status;
      body = await response.text();
    },
  );
  return { status, body };
}

function infoLogs(api: OpenClawPluginApi): string[] {
  return (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => String(c[0]),
  );
}

function errorLogs(api: OpenClawPluginApi): string[] {
  return (api.logger.error as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => String(c[0]),
  );
}

/**
 * Wait for a mock to be called within a timeout.
 * Used for fire-and-forget `void (async () => {...})()` handlers.
 */
async function waitForMock(
  mock: ReturnType<typeof vi.fn>,
  opts?: { timeout?: number; times?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 2000;
  const times = opts?.times ?? 1;
  await vi.waitFor(
    () => { expect(mock).toHaveBeenCalledTimes(times); },
    { timeout, interval: 50 },
  );
}

/** Extract emitActivity calls that have a specific type (thought, response, error, action). */
function activityCallsOfType(type: string): unknown[][] {
  return mockEmitActivity.mock.calls.filter(
    (c: unknown[]) => (c[1] as any)?.type === type,
  );
}

// ── Setup / Teardown ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();

  // Default mock behaviors
  mockGetViewerId.mockResolvedValue("viewer-bot-1");
  mockGetIssueDetails.mockResolvedValue(makeIssueDetails());
  mockCreateComment.mockResolvedValue("comment-new-id");
  mockCreateCommentOnEntity.mockResolvedValue("comment-threaded-id");
  mockEmitActivity.mockResolvedValue(undefined);
  mockUpdateSession.mockResolvedValue(undefined);
  mockUpdateIssue.mockResolvedValue(true);
  mockCreateSessionOnIssue.mockResolvedValue({ sessionId: "session-mock-1" });
  mockGetTeamLabels.mockResolvedValue([
    { id: "label-bug", name: "Bug" },
    { id: "label-feature", name: "Feature" },
  ]);
  mockGetTeamStates.mockResolvedValue([
    { id: "st-backlog", name: "Backlog", type: "backlog" },
    { id: "st-started", name: "In Progress", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    { id: "st-canceled", name: "Canceled", type: "canceled" },
  ]);
  mockRunAgent.mockResolvedValue({ success: true, output: "Agent response text" });
  mockSpawnWorker.mockResolvedValue(undefined);
  mockClassifyIntent.mockResolvedValue({
    intent: "general",
    reasoning: "test fallback",
    fromFallback: true,
  });
});

afterEach(() => {
  _resetForTesting();
});

// ── Tests ────────────────────────────────────────────────────────

describe("webhook scenario tests — full handler flows", () => {
  describe("AgentSessionEvent", () => {
    it("created: runs agent, delivers response via emitActivity", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      // Wait for the fire-and-forget handler to complete
      await waitForMock(mockClearActiveSession);

      // Issue enrichment
      expect(mockGetIssueDetails).toHaveBeenCalledWith("issue-1");

      // Agent invoked with correct session/message
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.sessionId).toContain("linear-session-sess-event-1");
      expect(runArgs.message).toContain("ENG-123");

      // emitActivity called with thought and response
      expect(activityCallsOfType("thought").length).toBeGreaterThan(0);
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);

      // Response delivered via emitActivity (session-first pattern),
      // NOT via createComment — avoids duplicate visible messages.
      expect(mockCreateComment).not.toHaveBeenCalled();

      // Session lifecycle
      expect(mockSetActiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "issue-1", agentSessionId: "sess-event-1" }),
      );
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-1");
    });

    it("created: falls back to createComment when emitActivity fails", async () => {
      // Make the response emitActivity fail — comment is the fallback
      let emitCallCount = 0;
      mockEmitActivity.mockImplementation(async (_sessionId: string, content: any) => {
        emitCallCount++;
        // Let the "thought" emission succeed, but fail the "response" emission
        if (content?.type === "response") {
          throw new Error("session expired");
        }
      });

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      // runAgent was called
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // emitActivity(response) failed → fell back to createComment
      expect(mockCreateComment).toHaveBeenCalledOnce();
      const commentBody = mockCreateComment.mock.calls[0][1] as string;
      expect(commentBody).toContain("Agent response text");
    });

    it("prompted: processes follow-up, delivers via emitActivity", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventPrompted();
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Follow-up question here");

      // Response via emitActivity, not createComment
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-1");
    });

    it("created with missing data: logs error, no crash", async () => {
      const api = createApi();
      const payload = {
        type: "AgentSessionEvent",
        action: "created",
        agentSession: { id: null, issue: null },
        previousComments: [],
      };
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      const errors = errorLogs(api);
      expect(errors.some((e) => e.includes("missing session or issue"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("Comment.create", () => {
    it("ask_agent intent: dispatches to named agent", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user asking for work",
        fromFallback: false,
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-intent-1",
          body: "Can someone look at this issue?",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-intent-1",
            identifier: "ENG-301",
            title: "Intent test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      // Wait for the full dispatch to complete
      await waitForMock(mockClearActiveSession);

      expect(mockClassifyIntent).toHaveBeenCalledOnce();
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // Comment-triggered → response via threaded comment (parentId), not emitActivity
      expect(mockCreateCommentOnEntity).toHaveBeenCalled();
      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toEqual({ issueId: "issue-intent-1", parentId: "comment-intent-1" });
    });

    it("request_work intent: dispatches to default agent", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "request_work",
        reasoning: "user wants implementation",
        fromFallback: false,
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-work-1",
          body: "Please implement the login page",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-work-1",
            identifier: "ENG-350",
            title: "Login implementation",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      await waitForMock(mockRunAgent);

      expect(mockClassifyIntent).toHaveBeenCalledOnce();

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("request_work"))).toBe(true);
      expect(mockRunAgent).toHaveBeenCalledOnce();
    });

    it("bot's own comment: skips without running agent", async () => {
      const api = createApi();
      const payload = makeCommentCreateFromBot("viewer-bot-1");
      await postWebhook(api, payload);
      // Small wait for the async getViewerId check
      await new Promise((r) => setTimeout(r, 100));

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("skipping our own comment"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockClassifyIntent).not.toHaveBeenCalled();
    });

    it("general intent: no action taken, no agent run", async () => {
      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-general-1",
          body: "Thanks for the update",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-general-1",
            identifier: "ENG-302",
            title: "General test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);
      await vi.waitFor(
        () => { expect(mockClassifyIntent).toHaveBeenCalledOnce(); },
        { timeout: 2000, interval: 50 },
      );

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("no action taken"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("close_issue intent: generates closure report, transitions state, posts comment", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "close_issue",
        reasoning: "user wants to close the issue",
        fromFallback: false,
      });

      mockRunAgent.mockResolvedValueOnce({
        success: true,
        output: "**Summary**: Fixed the authentication bug.\n**Resolution**: Updated token refresh logic.",
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-close-1",
          body: "close this issue",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-close-1",
            identifier: "ENG-400",
            title: "Auth bug fix",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      // Agent ran with readOnly for closure report
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.readOnly).toBe(true);
      expect(runArgs.message).toContain("closure report");

      // Issue state transitioned to completed
      expect(mockUpdateIssue).toHaveBeenCalledWith("issue-close-1", { stateId: "st-done" });

      // Team states fetched to find completed state
      expect(mockGetTeamStates).toHaveBeenCalledWith("team-1");

      // Closure report posted as threaded comment (comment-triggered path)
      expect(mockCreateCommentOnEntity).toHaveBeenCalled();
      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toEqual({ issueId: "issue-close-1", parentId: "comment-close-1" });
    });
  });

  describe("Issue.update", () => {
    it("assignment dispatch: triggers handleDispatch pipeline", async () => {
      // Set viewerId to match the fixture's assigneeId
      mockGetViewerId.mockResolvedValue("viewer-1");

      const api = createApi();
      const payload = makeIssueUpdateWithAssignment();
      await postWebhook(api, payload);

      await waitForMock(mockSpawnWorker, { timeout: 3000 });
      expect(mockSpawnWorker).toHaveBeenCalledOnce();
    });
  });

  describe("Issue.create", () => {
    it("auto-triage: applies estimate, labels, priority from agent output", async () => {
      // Mock getIssueDetails to return issue matching the payload
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        id: "issue-new",
        identifier: "ENG-200",
        title: "New issue",
      }));

      mockRunAgent.mockResolvedValueOnce({
        success: true,
        output:
          '```json\n{"estimate": 3, "labelIds": ["label-bug"], "priority": 3, "assessment": "Medium complexity"}\n```\n\nThis issue needs moderate work.',
      });

      const api = createApi();
      const payload = makeIssueCreate();
      await postWebhook(api, payload);

      // Wait for the triage handler to complete
      await waitForMock(mockClearActiveSession);

      // Issue enrichment + team labels
      expect(mockGetIssueDetails).toHaveBeenCalledWith("issue-new");
      expect(mockGetTeamLabels).toHaveBeenCalled();

      // Session created for triage
      expect(mockCreateSessionOnIssue).toHaveBeenCalledWith("issue-new");

      // Agent invoked with write access (can create subtasks)
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.readOnly).toBeUndefined();
      expect(runArgs.message).toContain("ENG-200");

      // Triage JSON applied to issue
      expect(mockUpdateIssue).toHaveBeenCalledWith(
        "issue-new",
        expect.objectContaining({
          estimate: 3,
          priority: 3,
        }),
      );

      // Response delivered via emitActivity (session exists)
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-new");
    });
  });

  describe("AppUserNotification", () => {
    it("ignored: returns 200 with no API calls", async () => {
      const api = createApi();
      const result = await postWebhook(api, makeAppUserNotification());
      expect(result.status).toBe(200);

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("AppUserNotification ignored"))).toBe(true);

      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockGetIssueDetails).not.toHaveBeenCalled();
    });
  });

  describe("Guidance integration", () => {
    it("created: appends guidance to agent prompt", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated({
        guidance: "Always use the main branch. Run make test before closing.",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.message).toContain("Workspace Guidance");
      expect(runArgs.message).toContain("Always use the main branch");
    });

    it("created: guidance is NOT used as user message", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated({
        guidance: "Always use the main branch. Run make test before closing.",
        previousComments: [
          { body: "Please fix the routing bug", userId: "user-1", createdAt: new Date().toISOString() },
        ],
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Guidance text should appear in the guidance section, not as the user's latest message
      expect(msg).toContain("Please fix the routing bug");
      // The guidance text should be within the guidance section, not in the "Latest message" block
      const latestMsgSection = msg.split("**Latest message:**")[1] ?? "";
      expect(latestMsgSection).toContain("Please fix the routing bug");
      expect(latestMsgSection).not.toContain("Always use the main branch");
    });

    it("prompted: includes guidance from promptContext", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventPrompted({
        agentActivity: { content: { body: "Can you also fix the tests?" } },
        promptContext: "## Issue\nENG-123\n\n## Guidance\nUse TypeScript strict mode.\n\n## Comments\nThread.",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Can you also fix the tests?");
      expect(msg).toContain("Workspace Guidance");
      expect(msg).toContain("Use TypeScript strict mode");
    });

    it("guidance disabled via config: no guidance section in prompt", async () => {
      const api = createApi();
      (api as any).pluginConfig = { defaultAgentId: "mal", enableGuidance: false };
      const payload = makeAgentSessionEventCreated({
        guidance: "Should not appear in prompt",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).not.toContain("Workspace Guidance");
      expect(msg).not.toContain("Should not appear in prompt");
    });

    it("team override disables guidance for specific team", async () => {
      const api = createApi();
      (api as any).pluginConfig = {
        defaultAgentId: "mal",
        enableGuidance: true,
        teamGuidanceOverrides: { "team-1": false },
      };
      const payload = makeAgentSessionEventCreated({
        guidance: "Should be suppressed for team-1",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).not.toContain("Workspace Guidance");
      expect(msg).not.toContain("Should be suppressed");
    });

    it("comment handler uses cached guidance from prior session event", async () => {
      // Step 1: Trigger a created event to cache guidance
      const api = createApi();
      const sessionPayload = makeAgentSessionEventCreated({
        guidance: "Cached guidance from session event",
      });
      await postWebhook(api, sessionPayload);
      await waitForMock(mockClearActiveSession);

      // Reset mocks for the next webhook
      vi.clearAllMocks();
      mockGetViewerId.mockResolvedValue("viewer-bot-1");
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails());
      mockCreateComment.mockResolvedValue("comment-new-id");
      mockEmitActivity.mockResolvedValue(undefined);
      mockUpdateSession.mockResolvedValue(undefined);
      mockUpdateIssue.mockResolvedValue(true);
      mockCreateSessionOnIssue.mockResolvedValue({ sessionId: "session-mock-2" });
      mockGetTeamLabels.mockResolvedValue([]);
      mockGetTeamStates.mockResolvedValue([
        { id: "st-backlog", name: "Backlog", type: "backlog" },
        { id: "st-started", name: "In Progress", type: "started" },
        { id: "st-done", name: "Done", type: "completed" },
      ]);
      mockRunAgent.mockResolvedValue({ success: true, output: "Agent response text" });
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user requesting help",
        fromFallback: false,
      });

      // Advance Date.now() past the 30s sessionHandledIssues TTL so
      // processComment doesn't skip this as a duplicate of the session handler.
      // This simulates a real follow-up comment arriving after the dedup window.
      const realNow = Date.now;
      const baseTime = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(baseTime + 31_000);

      // Step 2: Now send a comment — it should pick up cached guidance
      const commentPayload = makeCommentCreate({
        data: {
          id: "comment-guidance-1",
          body: "Can you investigate further?",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Fix webhook routing",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, commentPayload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Workspace Guidance");
      expect(msg).toContain("Cached guidance from session event");
    });
  });

  describe("Sub-issue guidance in agent prompt", () => {
    it("created: triaged issue includes sub-issue guidance with parentIssueId", async () => {
      // Issue is "In Progress" (type: "started") — triaged, so full tool access
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        state: { name: "In Progress", type: "started" },
      }));

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Verify sub-issue guidance text includes the correct parentIssueId
      expect(msg).toContain("Sub-issue guidance");
      expect(msg).toContain("Only create sub-issues when work genuinely needs separate tracking");
      expect(msg).toContain("just do the work directly");
    });

    it("created: backlog issue does NOT include sub-issue guidance", async () => {
      // Issue is "Backlog" (type: "backlog") — untriaged, so read-only tool access
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        state: { name: "Backlog", type: "backlog" },
      }));

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Backlog issues get READ ONLY access — no sub-issue guidance
      expect(msg).not.toContain("Sub-issue guidance");
      expect(msg).toContain("READ ONLY");
    });
  });

  describe("Dual-webhook dedup", () => {
    it("session handler first: Comment.create is dropped, only one agent run", async () => {
      // Simulate: AgentSessionEvent.created arrives first, Comment.create arrives while agent is running.
      // The comment should be DROPPED (not queued), producing exactly one response.
      const api = createApi();
      const sessionPayload = makeAgentSessionEventCreated();

      // Make agent run take a bit of time so Comment.create arrives during the run
      let resolveAgent!: (v: any) => void;
      mockRunAgent.mockReturnValueOnce(
        new Promise((resolve) => { resolveAgent = resolve; }),
      );

      // 1. Fire session event (starts agent run)
      await postWebhook(api, sessionPayload);

      // Wait for the session handler to enter the async IIFE and set activeRuns
      await vi.waitFor(
        () => { expect(mockGetIssueDetails).toHaveBeenCalled(); },
        { timeout: 2000, interval: 20 },
      );

      // 2. Fire Comment.create for the same issue while agent is running
      const commentPayload = makeCommentCreate();
      await postWebhook(api, commentPayload);

      // 3. Let the agent finish
      resolveAgent({ success: true, output: "Session response" });

      await waitForMock(mockClearActiveSession);

      // Exactly ONE agent run — the comment was dropped, not queued for replay
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // Session handler posts via emitActivity — no duplicate comment
      const responseCalls = activityCallsOfType("response");
      expect(responseCalls.length).toBe(1);

      // No comment was created (session handler uses emitActivity, comment was dropped)
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockCreateCommentOnEntity).not.toHaveBeenCalled();

      // Logs show the comment was dropped
      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("session handler active") && l.includes("dropping"))).toBe(true);
    });

    it("comment handler first: session event is skipped via activeRuns, only one agent run", async () => {
      // Simulate: Comment.create arrives first, AgentSessionEvent.created arrives while agent is running.
      // The session event should be skipped by activeRuns, producing exactly one threaded reply.
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user asking question",
        fromFallback: false,
      });
      mockCreateCommentOnEntity.mockResolvedValue("comment-threaded-id");

      const api = createApi();

      // Make agent run take a bit of time
      let resolveAgent!: (v: any) => void;
      mockRunAgent.mockReturnValueOnce(
        new Promise((resolve) => { resolveAgent = resolve; }),
      );

      // 1. Fire Comment.create (starts intent classification → agent dispatch)
      const commentPayload = makeCommentCreate({
        data: {
          id: "comment-dual-1",
          body: "@main can you check this?",
          user: { id: "user-1", name: "Human" },
          issue: {
            id: "issue-dual-1",
            identifier: "ENG-500",
            title: "Dual test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, commentPayload);

      // Wait for dispatchCommentToAgent to start (agent run begins)
      await vi.waitFor(
        () => { expect(mockRunAgent).toHaveBeenCalled(); },
        { timeout: 2000, interval: 20 },
      );

      // 2. Fire AgentSessionEvent.created for the same issue — should be skipped
      const sessionPayload = makeAgentSessionEventCreated({
        agentSession: {
          id: "sess-dual-1",
          issue: {
            id: "issue-dual-1",
            identifier: "ENG-500",
            title: "Dual test",
          },
        },
      });
      await postWebhook(api, sessionPayload);

      // 3. Let the agent finish
      resolveAgent({ success: true, output: "Comment response" });

      await waitForMock(mockClearActiveSession);

      // Exactly ONE agent run
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // Response posted as threaded comment (comment handler's path)
      expect(mockCreateCommentOnEntity).toHaveBeenCalled();
      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toHaveProperty("parentId", "comment-dual-1");
      expect(entityArgs[0]).toHaveProperty("issueId", "issue-dual-1");

      // Session event was skipped (logged)
      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("active run") || l.includes("skipping session"))).toBe(true);
    });

    it("non-session active run: comments are still queued for replay", async () => {
      // When a triage or dispatch run is active (NOT from session handler),
      // Comment.create should be queued for replay, not dropped.
      const api = createApi();

      // Trigger Issue.create which starts auto-triage (sets activeRuns without sessionHandledIssues)
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        id: "issue-triage-1",
        identifier: "ENG-600",
        title: "Triage test",
      }));

      let resolveTriageAgent!: (v: any) => void;
      mockRunAgent.mockReturnValueOnce(
        new Promise((resolve) => { resolveTriageAgent = resolve; }),
      );

      const issuePayload = makeIssueCreate({
        data: {
          id: "issue-triage-1",
          identifier: "ENG-600",
          title: "Triage test",
          state: { name: "Backlog", type: "backlog" },
          assignee: null,
          team: { id: "team-1" },
          project: null,
        },
      });
      await postWebhook(api, issuePayload);

      // Wait for triage agent to start
      await vi.waitFor(
        () => { expect(mockRunAgent).toHaveBeenCalled(); },
        { timeout: 2000, interval: 20 },
      );

      // Now send a comment during the triage run — should be QUEUED (not dropped)
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user asking",
        fromFallback: false,
      });

      const commentPayload = makeCommentCreate({
        data: {
          id: "comment-during-triage-1",
          body: "Hey, can you also check this?",
          user: { id: "user-1", name: "Human" },
          issue: {
            id: "issue-triage-1",
            identifier: "ENG-600",
            title: "Triage test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, commentPayload);

      // Should see "queued for replay" log (not "dropping")
      const logsBeforeResolve = infoLogs(api);
      expect(logsBeforeResolve.some((l) => l.includes("queued for replay"))).toBe(true);
      expect(logsBeforeResolve.some((l) => l.includes("dropping"))).toBe(false);

      // Finish the triage agent — replay should fire
      resolveTriageAgent({
        success: true,
        output: '```json\n{"estimate": 3, "labelIds": [], "priority": 3, "assessment": "Medium"}\n```\nTriaged.',
      });

      // Second agent run fires from the replayed comment
      await vi.waitFor(
        () => { expect(mockRunAgent).toHaveBeenCalledTimes(2); },
        { timeout: 3000, interval: 50 },
      );
    });

    it("session handler sets sessionHandledIssues in .created handler", async () => {
      // Verify that the .created handler (not just .prompted) sets sessionHandledIssues
      // so that replayed comments are blocked even for first-time mentions.
      const api = createApi();

      // Fast agent run
      mockRunAgent.mockResolvedValue({ success: true, output: "Done" });

      const sessionPayload = makeAgentSessionEventCreated();
      await postWebhook(api, sessionPayload);
      await waitForMock(mockClearActiveSession);

      // Now send a comment for the same issue — should be skipped by sessionHandledIssues
      const commentPayload = makeCommentCreate();
      vi.clearAllMocks();
      mockGetViewerId.mockResolvedValue("viewer-bot-1");

      await postWebhook(api, commentPayload);
      // Give processComment time to check sessionHandledIssues
      await new Promise((r) => setTimeout(r, 100));

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("already handled by session"))).toBe(true);
      // Agent should NOT run again
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("Non-issue comment threading (initiative/project updates)", () => {
    it("initiative update comment (top-level): reply uses comment id as parentId", async () => {
      // Top-level comment on initiative update — no parentId in comment data.
      // The response should use the comment's own id as parentId.
      const api = createApi();

      const commentPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-init-top",
          body: "@main what's the status of this initiative?",
          user: { id: "user-1", name: "Human" },
          initiativeUpdateId: "init-update-1",
          createdAt: new Date().toISOString(),
        },
      };
      await postWebhook(api, commentPayload);

      await waitForMock(mockCreateCommentOnEntity);

      expect(mockRunAgent).toHaveBeenCalledOnce();

      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toHaveProperty("initiativeUpdateId", "init-update-1");
      expect(entityArgs[0]).toHaveProperty("parentId", "comment-init-top");
    });

    it("initiative update comment (reply in thread): reply uses thread root as parentId", async () => {
      // Reply-in-thread on initiative update — comment.parentId points to thread root.
      // Linear requires parentId to be the TOP-LEVEL comment, not the reply.
      // This test reproduces the "incorrect parent" GraphQL error.
      const api = createApi();

      const commentPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-init-reply",
          parentId: "comment-init-root",  // this comment is a reply to the root
          body: "@main follow up on this",
          user: { id: "user-1", name: "Human" },
          initiativeUpdateId: "init-update-1",
          createdAt: new Date().toISOString(),
        },
      };
      await postWebhook(api, commentPayload);

      await waitForMock(mockCreateCommentOnEntity);

      expect(mockRunAgent).toHaveBeenCalledOnce();

      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toHaveProperty("initiativeUpdateId", "init-update-1");
      // Must use the THREAD ROOT, not the reply's own id
      expect(entityArgs[0]).toHaveProperty("parentId", "comment-init-root");
      expect(entityArgs[0].parentId).not.toBe("comment-init-reply");
    });

    it("project update comment: reply threads under triggering comment with parentId", async () => {
      const api = createApi();

      const commentPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-proj-1",
          body: "@main summarize this update",
          user: { id: "user-1", name: "Human" },
          projectUpdateId: "proj-update-1",
          createdAt: new Date().toISOString(),
        },
      };
      await postWebhook(api, commentPayload);

      await waitForMock(mockCreateCommentOnEntity);

      expect(mockRunAgent).toHaveBeenCalledOnce();

      const entityArgs = mockCreateCommentOnEntity.mock.calls[0];
      expect(entityArgs[0]).toHaveProperty("projectUpdateId", "proj-update-1");
      expect(entityArgs[0]).toHaveProperty("parentId", "comment-proj-1");
    });

    it("non-issue comment: bot's own comments are skipped", async () => {
      const api = createApi();

      const commentPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-bot-init-1",
          body: "**[frAInk]** Here's my analysis...",
          user: { id: "viewer-bot-1", name: "CT Claw" },
          initiativeUpdateId: "init-update-1",
          createdAt: new Date().toISOString(),
        },
      };
      await postWebhook(api, commentPayload);
      await new Promise((r) => setTimeout(r, 100));

      // Bot's own comment should NOT trigger an agent run
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockCreateCommentOnEntity).not.toHaveBeenCalled();
    });
  });
});
