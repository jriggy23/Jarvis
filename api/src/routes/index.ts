import { Request, Response, Router } from "express";
import { authStub } from "../auth";
import { AppConfig } from "../config/secrets";
import { BrainProvider } from "../providers/types";
import { VoiceProvider } from "../providers/types";
import { SessionStore } from "../sessions";

export interface RouterDeps {
  config: AppConfig;
  store: SessionStore;
  voiceProvider: VoiceProvider;
  brainProvider: BrainProvider;
}

export function buildRouter(deps: RouterDeps): Router {
  const router = Router();
  const { config, store, voiceProvider, brainProvider } = deps;

  // Liveness/readiness — no auth.
  router.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Everything below the healthz check goes through the auth stub.
  router.use(authStub);

  // Bootstrap config for clients (default voice, feature flags).
  const bootstrap = (_req: Request, res: Response) => {
    res.json({
      user: { authenticated: false, note: "auth stubbed in v1" },
      defaultVoiceId: config.defaultVoiceId,
      features: {
        speech: true,
        voicePicker: true,
        // Brain is a stub until step 3 (Claude Agent SDK).
        brainStub: true,
      },
    });
  };
  router.get("/config", bootstrap);
  router.get("/me", bootstrap);

  // List available voices from the voice provider.
  router.get("/voices", async (_req: Request, res: Response) => {
    try {
      const voices = await voiceProvider.listVoices();
      res.json({ voices, defaultVoiceId: config.defaultVoiceId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create a session.
  router.post("/sessions", (_req: Request, res: Response) => {
    const session = store.create();
    res.status(201).json({ sessionId: session.id });
  });

  // Session state/config.
  router.get("/sessions/:id", (req: Request, res: Response) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({
      sessionId: session.id,
      activeVoiceId: session.activeVoiceId,
      speakResponses: session.speakResponses,
      messageCount: session.history.length,
      createdAt: session.createdAt,
    });
  });

  // Update session config.
  router.patch("/sessions/:id", (req: Request, res: Response) => {
    const { activeVoiceId, speakResponses } = req.body ?? {};
    const session = store.update(req.params.id, { activeVoiceId, speakResponses });
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({
      sessionId: session.id,
      activeVoiceId: session.activeVoiceId,
      speakResponses: session.speakResponses,
    });
  });

  // Conversation history.
  router.get("/sessions/:id/messages", (req: Request, res: Response) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ messages: session.history });
  });

  // Run a typed turn through the (stub) brain and return the assistant message.
  // v1 returns a single JSON response; SSE streaming is available over the WS
  // path. Streaming-over-REST can be added later without changing the contract.
  router.post("/sessions/:id/messages", async (req: Request, res: Response) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });

    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) return res.status(400).json({ error: "text is required" });

    store.appendMessage(session.id, { role: "user", content: text });

    try {
      let assistant = "";
      for await (const token of brainProvider.stream(session.history, text)) {
        assistant += token;
      }
      store.appendMessage(session.id, { role: "assistant", content: assistant });
      res.json({ message: { role: "assistant", content: assistant } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
