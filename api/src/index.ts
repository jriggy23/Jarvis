// Telemetry must initialise before anything else so App Insights can
// auto-instrument the HTTP server.
import { initTelemetry } from "./config/telemetry";
initTelemetry();

import cors from "cors";
import express from "express";
import http from "http";
import { loadConfig } from "./config/secrets";
import { AzureSpeechProvider } from "./providers/azureSpeech";
import { ClaudeBrainProvider } from "./providers/claudeBrain";
import { buildRouter } from "./routes";
import { SessionStore } from "./sessions";
import { attachRealtime } from "./ws/realtime";

// Allowed CORS origins: the deployed SWA site + local Vite dev.
const ALLOWED_ORIGINS = [
  "https://ambitious-sea-0cf341e0f.7.azurestaticapps.net",
  "http://localhost:5173",
];

async function main(): Promise<void> {
  const config = await loadConfig();

  const voiceProvider = new AzureSpeechProvider(config.speechKey, config.speechRegion);
  const brainProvider = new ClaudeBrainProvider();
  console.log(
    `[brain] Claude Agent SDK brain ready: model=${process.env.CLAUDE_MODEL || "claude-opus-4-8"}, ` +
      `auth=${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "Claude Max OAuth" : "MISSING (awaiting claude-oauth-token)"}`,
  );
  const store = new SessionStore(config.defaultVoiceId);

  // Eagerly validate the Speech provider initialised (proves the key loaded).
  const voices = await voiceProvider.listVoices();
  console.log(
    `[speech] Provider ready: region=${config.speechRegion}, ${voices.length} voices, default=${config.defaultVoiceId}`,
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / non-browser (no Origin header) and the allowlist.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
        else cb(null, false);
      },
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.use(buildRouter({ config, store, voiceProvider, brainProvider }));

  const server = http.createServer(app);

  // Share the HTTP server with the WebSocket gateway (WS upgrade on /realtime).
  attachRealtime(server, {
    store,
    voiceProvider,
    brainProvider,
    defaultVoiceId: config.defaultVoiceId,
  });

  server.listen(config.port, () => {
    console.log(`[jarvis-api] listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error("[jarvis-api] fatal startup error:", err);
  process.exit(1);
});
