import { BrainProvider, ChatMessage } from "./types";

/**
 * Stub "echo" brain for v1. Streams back a short canned reply that references
 * the user's input, word-by-word with a tiny delay, so the token -> TTS
 * pipeline is exercised end to end.
 *
 * TODO(step 3): replace with the Claude Agent SDK (Dispatch-style session,
 * subscription auth, real token streaming). See JARVIS-AZURE-PLAN.md §5.
 */
export class StubBrainProvider implements BrainProvider {
  private readonly tokenDelayMs: number;

  constructor(tokenDelayMs = 40) {
    this.tokenDelayMs = tokenDelayMs;
  }

  async *stream(_history: ChatMessage[], userText: string): AsyncIterable<string> {
    const trimmed = userText.trim();
    const reply =
      `Hello, I'm Jarvis. You said: "${trimmed}". ` +
      `This is a stub response while the Claude brain is wired up.`;

    // Emit word-by-word, preserving spacing, to simulate token streaming.
    const tokens = reply.split(/(\s+)/).filter((t) => t.length > 0);
    for (const token of tokens) {
      await delay(this.tokenDelayMs);
      yield token;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
