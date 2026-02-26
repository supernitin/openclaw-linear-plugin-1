import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { refreshTokenProactively } from "../api/linear-api.js";

let refreshInterval: ReturnType<typeof setInterval> | null = null;

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Start the proactive token refresh timer.
 * Runs immediately on start, then every 6 hours.
 */
export function startTokenRefreshTimer(
  api: OpenClawPluginApi,
  pluginConfig?: Record<string, unknown>,
): void {
  if (refreshInterval) return; // Already running

  const doRefresh = async () => {
    try {
      const result = await refreshTokenProactively(pluginConfig);
      if (result.refreshed) {
        api.logger.info(`Linear token refresh: ${result.reason}`);
      } else {
        api.logger.debug(`Linear token refresh skipped: ${result.reason}`);
      }
    } catch (err) {
      api.logger.warn(`Linear token refresh failed: ${err}`);
    }
  };

  // Run immediately
  void doRefresh();

  // Then every 6 hours
  refreshInterval = setInterval(doRefresh, REFRESH_INTERVAL_MS);
  refreshInterval.unref(); // Allow process to exit (fixes openclaw update hang)
  api.logger.info(`Linear token refresh timer started (every ${REFRESH_INTERVAL_MS / 3600000}h)`);
}

export function stopTokenRefreshTimer(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
