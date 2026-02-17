const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export class LinearClient {
  constructor(private accessToken: string) {}

  async request<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Linear API request failed: ${res.status} ${text}`);
    }

    const payload = await res.json();
    if (payload.errors) {
      throw new Error(`Linear API returned errors: ${JSON.stringify(payload.errors)}`);
    }

    return payload.data as T;
  }

  async getViewer() {
    const query = `
      query {
        viewer {
          id
          name
          email
        }
      }
    `;
    return this.request(query);
  }

  async listIssues(params: { limit: number; teamId?: string }) {
    const query = `
      query ListIssues($limit: Int, $teamId: String) {
        issues(first: $limit, filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            identifier
            title
            description
            state {
              name
            }
            assignee {
              name
            }
          }
        }
      }
    `;
    return this.request(query, params);
  }

  async createIssue(params: { title: string; description?: string; teamId: string }) {
    const query = `
      mutation CreateIssue($title: String!, $description: String, $teamId: String!) {
        issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
          success
          issue {
            id
            identifier
            title
          }
        }
      }
    `;
    return this.request(query, params);
  }

  async addComment(params: { issueId: string; body: string }) {
    const query = `
      mutation AddComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `;
    return this.request(query, params);
  }

}
