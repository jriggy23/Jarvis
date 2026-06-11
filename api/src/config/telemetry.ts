/**
 * Application Insights bootstrap. No-op unless the connection string is present
 * (so local dev runs clean). Must be required as early as possible in index.ts
 * for auto-instrumentation to hook the HTTP server.
 */
export function initTelemetry(): void {
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) {
    console.log("[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set; skipping App Insights.");
    return;
  }
  try {
    // Lazy require so a missing/incompatible SDK never crashes startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appInsights = require("applicationinsights");
    appInsights
      .setup(conn)
      .setAutoCollectConsole(true, true)
      .setSendLiveMetrics(false)
      .start();
    appInsights.defaultClient.context.tags[appInsights.defaultClient.context.keys.cloudRole] = "jarvis-api";
    console.log("[telemetry] Application Insights initialised.");
  } catch (err) {
    console.warn("[telemetry] Failed to initialise App Insights:", (err as Error).message);
  }
}
