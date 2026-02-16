import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { LinearClient } from "./client.js";

export function createLinearTools(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  const getClient = () => {
    // In a real implementation, we would resolve the token from auth profiles
    // For now, we'll try to get it from environment or a known profile
    const token = process.env.LINEAR_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Linear access token not found. Please authenticate first.");
    }
    return new LinearClient(token);
  };
  
  return [
    {
      name: "linear_list_issues",
      description: "List issues from a Linear workspace",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max issues to return", default: 10 },
          teamId: { type: "string", description: "Filter by team ID" }
        }
      },
      execute: async ({ limit, teamId }) => {
        const client = getClient();
        const data = await client.listIssues({ limit, teamId });
        return jsonResult({ 
          message: `Found ${data.issues.nodes.length} issues`,
          issues: data.issues.nodes 
        });
      }
    },
    {
      name: "linear_create_issue",
      description: "Create a new issue in Linear",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Issue description" },
          teamId: { type: "string", description: "Team ID" }
        },
        required: ["title", "teamId"]
      },
      execute: async ({ title, description, teamId }) => {
        const client = getClient();
        const data = await client.createIssue({ title, description, teamId });
        if (data.issueCreate.success) {
          return jsonResult({
            message: "Created issue successfully",
            issue: data.issueCreate.issue
          });
        }
        return jsonResult({ message: "Failed to create issue" });
      }
    },
    {
      name: "linear_add_comment",
      description: "Add a comment to a Linear issue",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          body: { type: "string", description: "Comment body" }
        },
        required: ["issueId", "body"]
      },
      execute: async ({ issueId, body }) => {
        const client = getClient();
        const data = await client.addComment({ issueId, body });
        if (data.commentCreate.success) {
          return jsonResult({
            message: "Added comment successfully",
            commentId: data.commentCreate.comment.id
          });
        }
        return jsonResult({ message: "Failed to add comment" });
      }
    }
  ];
}
