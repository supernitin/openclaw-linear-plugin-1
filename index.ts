import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerLinearProvider } from "./src/auth.js";
import { createLinearTools } from "./src/tools.js";
import { handleLinearWebhook } from "./src/webhook.js";
import { handleOAuthCallback } from "./src/oauth-callback.js";
import { resolveLinearToken } from "./src/linear-api.js";

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  // Check token availability (config → env → auth profile store)
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) {
    api.logger.warn(
      "Linear: no access token found. Options: (1) run OAuth flow, (2) set LINEAR_ACCESS_TOKEN env var, " +
      "(3) add accessToken to plugin config. Agent pipeline will not function without it.",
    );
  }

  // Register Linear as an auth provider (OAuth flow with agent scopes)
  registerLinearProvider(api);

  // Register Linear tools for the agent
  api.registerTool((ctx) => {
    return createLinearTools(api, ctx);
  });

  // Register Linear webhook handler on a dedicated route
  api.registerHttpRoute({
    path: "/linear/webhook",
    handler: async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
  });

  // Back-compat route so existing production webhook URLs keep working.
  api.registerHttpRoute({
    path: "/hooks/linear",
    handler: async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
  });

  // Register OAuth callback route
  api.registerHttpRoute({
    path: "/linear/oauth/callback",
    handler: async (req, res) => {
      await handleOAuthCallback(api, req, res);
    },
  });

  const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";
  api.logger.info(
    `Linear agent extension registered (agent: ${agentId}, token: ${tokenInfo.source !== "none" ? `${tokenInfo.source}` : "missing"})`,
  );
}
