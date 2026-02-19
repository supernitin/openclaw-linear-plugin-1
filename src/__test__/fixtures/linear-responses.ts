/**
 * Factory functions for Linear GraphQL response shapes.
 *
 * Matches the return types of LinearAgentApi methods.
 */

export function makeIssueDetails(overrides?: Record<string, unknown>) {
  return {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix webhook routing",
    description: "The webhook handler needs fixing.",
    estimate: 3,
    state: { name: "In Progress" },
    assignee: { name: "Agent" },
    labels: { nodes: [] as Array<{ id: string; name: string }> },
    team: { id: "team-1", name: "Engineering", issueEstimationType: "notUsed" },
    comments: { nodes: [] as Array<{ body: string; user: { name: string } | null; createdAt: string }> },
    project: null as { id: string; name: string } | null,
    parent: null as { id: string; identifier: string } | null,
    relations: { nodes: [] as Array<{ type: string; relatedIssue: { id: string; identifier: string; title: string } }> },
    ...overrides,
  };
}

export function makeProjectIssue(
  identifier: string,
  opts?: {
    title?: string;
    description?: string;
    estimate?: number;
    priority?: number;
    state?: { name: string; type: string };
    parentIdentifier?: string;
    labels?: string[];
    relations?: Array<{ type: string; relatedIdentifier: string; relatedTitle?: string }>;
  },
) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: opts?.title ?? `Issue ${identifier}`,
    description: opts?.description ?? null,
    estimate: opts?.estimate ?? null,
    priority: opts?.priority ?? 0,
    state: opts?.state ?? { name: "Backlog", type: "backlog" },
    parent: opts?.parentIdentifier
      ? { id: `id-${opts.parentIdentifier}`, identifier: opts.parentIdentifier }
      : null,
    labels: {
      nodes: (opts?.labels ?? []).map((name) => ({ id: `label-${name}`, name })),
    },
    relations: {
      nodes: (opts?.relations ?? []).map((r) => ({
        type: r.type,
        relatedIssue: {
          id: `id-${r.relatedIdentifier}`,
          identifier: r.relatedIdentifier,
          title: r.relatedTitle ?? `Issue ${r.relatedIdentifier}`,
        },
      })),
    },
  };
}

export function makeProject(overrides?: Record<string, unknown>) {
  return {
    id: "proj-1",
    name: "Test Project",
    description: "A test project",
    state: "started",
    teams: { nodes: [{ id: "team-1", name: "Engineering" }] },
    ...overrides,
  };
}
