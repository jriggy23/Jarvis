import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { BrainProvider, ChatMessage } from "./types";

/**
 * Real streaming Claude brain backed by the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 * Auth: the SDK draws on the user's Claude Max subscription via the
 * `CLAUDE_CODE_OAUTH_TOKEN` env var (loaded from Key Vault at startup in
 * config/secrets.ts). An `ANTHROPIC_API_KEY` Console-key fallback is honoured
 * by the SDK if present, but the Max-subscription OAuth path is primary.
 *
 * Model: `CLAUDE_MODEL` env var, defaulting to `claude-opus-4-8`.
 *
 * Conversation continuity: this provider is a single instance shared across all
 * Jarvis sessions (see index.ts / RealtimeDeps), and `stream(history, userText)`
 * does not carry a session key — so SDK `resume` keyed on a shared field would
 * cross-contaminate concurrent sessions. Instead we replay *this* session's
 * `history` (which the WS/REST callers supply per-session) into the prompt each
 * turn. That keeps multi-turn memory correct and isolated — a follow-up like
 * "what did I just say?" resolves against the right conversation. The SDK still
 * assigns a fresh `session_id` per turn; we read it only for logging/telemetry.
 *
 * Tools are OFF for v1 (no file/bash/web tools) — this is the conversational
 * brain; agentic tools are a later (v2) step.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

const JARVIS_SYSTEM_PROMPT =
  "You are Jarvis, a calm, concise AI assistant with a refined British manner. " +
  "Speak in a measured, articulate, lightly formal British register. " +
  "Be helpful, direct, and to the point — favour short, clear replies over long ones, " +
  "and never pad with filler. Your responses are read aloud, so write plainly: " +
  "no markdown, no bullet lists, no code fences, no emoji.";

export class ClaudeBrainProvider implements BrainProvider {
  private readonly model: string;

  constructor(model = process.env.CLAUDE_MODEL || DEFAULT_MODEL) {
    this.model = model;
  }

  /**
   * Stream the assistant reply token-by-token for the given turn.
   *
   * NOTE on `history`: both callers (WS runTurn and REST POST /messages) append
   * the current user turn to the session before calling stream(), so the final
   * element of `history` is this same `userText`. buildPrompt() drops that
   * trailing duplicate so the current turn isn't sent twice.
   */
  async *stream(history: ChatMessage[], userText: string): AsyncIterable<string> {
    const options: Options = {
      model: this.model,
      systemPrompt: JARVIS_SYSTEM_PROMPT,
      // Conversational brain only: disable all built-in tools for v1.
      tools: [],
      // Emit token-level `stream_event` partials so WS brain.token / clause TTS work.
      includePartialMessages: true,
      // Single model turn per call; we drive multi-turn via history replay.
      maxTurns: 1,
      // No interactive permission prompts in a headless service.
      permissionMode: "bypassPermissions",
      // Surface the bundled CLI's stderr so spawn/auth failures are diagnosable.
      stderr: (data: string) => {
        if (data && data.trim()) console.error("[claude-cli]", data.trimEnd());
      },
    };

    const prompt = buildPrompt(history, userText);

    try {
      for await (const message of query({ prompt, options })) {
        // Token-level text deltas arrive as raw streaming events.
        if (message.type === "stream_event") {
          const ev = message.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta" &&
            ev.delta.text
          ) {
            yield ev.delta.text;
          }
        } else if (message.type === "result") {
          // Log non-success results (error subtypes carry the cause).
          const r = message as unknown as { subtype?: string };
          if (r.subtype && r.subtype !== "success") {
            console.error("[claude-brain] result:", JSON.stringify(message));
          }
        }
      }
    } catch (err) {
      console.error("[claude-brain] query failed:", err);
      throw err;
    }
  }
}

/**
 * Build the turn prompt. With no prior history, send the user text alone. With
 * history, prepend a compact transcript so the model has conversational context
 * (the SDK is stateless per call here — see the class doc for why we don't use
 * `resume`).
 */
function buildPrompt(history: ChatMessage[], userText: string): string {
  // Callers append the current user turn to history before calling stream(), so
  // the last element is this same userText — drop it to avoid duplicating it.
  const prior =
    history.length > 0 &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].content === userText
      ? history.slice(0, -1)
      : history;

  if (prior.length === 0) return userText;

  const transcript = prior
    .map((m) => `${m.role === "user" ? "User" : "Jarvis"}: ${m.content}`)
    .join("\n");
  return (
    "Continue this conversation. Prior turns:\n" +
    `${transcript}\n\n` +
    `User: ${userText}`
  );
}
