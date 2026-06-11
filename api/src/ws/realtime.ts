import { IncomingMessage } from "http";
import { Server as HttpServer } from "http";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { SentenceChunker } from "../chunker";
import {
  BrainProvider,
  Transcriber,
  VoiceProvider,
} from "../providers/types";
import { Session, SessionStore } from "../sessions";

export interface RealtimeDeps {
  store: SessionStore;
  voiceProvider: VoiceProvider;
  brainProvider: BrainProvider;
  defaultVoiceId: string;
}

type TurnState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Per-connection orchestration for /realtime. Implements the turn state machine
 * (plan §2.2): idle -> listening (feed audio to STT) -> on audio.end emit
 * stt.final -> thinking (brain.status) -> stream brain.token while chunking text
 * into TTS -> stream tts.audio -> turn.complete.
 *
 *  - text.message skips STT (the text IS the transcript).
 *  - control.barge_in cancels in-flight brain/TTS for this connection.
 *  - control.set_voice updates the session's active voice.
 */
class Connection {
  private state: TurnState = "idle";
  private transcriber: Transcriber | null = null;
  private finalTranscript = "";
  /** Bumped on every new turn / barge-in to abandon stale async work. */
  private turnEpoch = 0;
  private session: Session | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: RealtimeDeps,
    sessionId: string | null,
  ) {
    // Bind to an existing session if one was passed; otherwise create one so a
    // bare WS client still works.
    if (sessionId) this.session = deps.store.get(sessionId) ?? null;
    if (!this.session) this.session = deps.store.create();

    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.cleanup());
    ws.on("error", () => this.cleanup());

    this.send({ type: "ready", sessionId: this.session.id });
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private sendError(message: string): void {
    this.send({ type: "error", message });
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    // Binary frames are raw PCM audio chunks for STT.
    if (isBinary) {
      this.handleAudioChunk(data as Buffer);
      return;
    }

    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.sendError("invalid JSON control message");
      return;
    }

    switch (msg.type) {
      case "audio.chunk":
        // Base64-encoded audio over the JSON channel (alternative to binary).
        if (typeof msg.data === "string") {
          this.handleAudioChunk(Buffer.from(msg.data, "base64"));
        }
        break;
      case "audio.end":
        void this.handleAudioEnd();
        break;
      case "text.message":
        if (typeof msg.text === "string") void this.handleText(msg.text);
        else this.sendError("text.message requires a text field");
        break;
      case "control.barge_in":
        this.handleBargeIn();
        break;
      case "control.set_voice":
        if (typeof msg.voiceId === "string") this.handleSetVoice(msg.voiceId);
        else this.sendError("control.set_voice requires a voiceId");
        break;
      default:
        this.sendError(`unknown message type: ${String(msg.type)}`);
    }
  }

  private ensureTranscriber(): Transcriber {
    if (this.transcriber) return this.transcriber;
    this.finalTranscript = "";
    this.transcriber = this.deps.voiceProvider.createTranscriber({
      onPartial: (text) => this.send({ type: "stt.partial", text }),
      onFinal: (text) => {
        // Accumulate finals across the utterance.
        this.finalTranscript = this.finalTranscript
          ? `${this.finalTranscript} ${text}`
          : text;
      },
      onError: (err) => this.sendError(`stt: ${err.message}`),
    });
    this.transcriber.start();
    return this.transcriber;
  }

  private handleAudioChunk(chunk: Buffer): void {
    if (this.state !== "listening") {
      this.state = "listening";
    }
    try {
      this.ensureTranscriber().pushAudio(chunk);
    } catch (err) {
      this.sendError(`stt push failed: ${(err as Error).message}`);
    }
  }

  private async handleAudioEnd(): Promise<void> {
    if (!this.transcriber) {
      this.sendError("audio.end with no active audio stream");
      return;
    }
    await this.transcriber.stop();
    this.transcriber = null;
    const transcript = this.finalTranscript.trim();
    this.state = "idle";
    this.send({ type: "stt.final", text: transcript });
    if (transcript) await this.runTurn(transcript);
    else this.send({ type: "turn.complete" });
  }

  private async handleText(text: string): Promise<void> {
    // Typed turn: the text IS the transcript; STT is skipped.
    this.send({ type: "stt.final", text });
    await this.runTurn(text);
  }

  private handleBargeIn(): void {
    // Abandon any in-flight brain/TTS work by advancing the epoch.
    this.turnEpoch += 1;
    this.state = "idle";
    this.send({ type: "turn.complete", interrupted: true });
  }

  private handleSetVoice(voiceId: string): void {
    if (this.session) {
      this.deps.store.update(this.session.id, { activeVoiceId: voiceId });
    }
    this.send({ type: "control.set_voice.ack", voiceId });
  }

  /** thinking -> stream brain tokens -> chunk into TTS -> speaking -> complete. */
  private async runTurn(userText: string): Promise<void> {
    if (!this.session) return;
    const epoch = ++this.turnEpoch;
    const session = this.session;

    this.deps.store.appendMessage(session.id, { role: "user", content: userText });

    this.state = "thinking";
    this.send({ type: "brain.status", status: "thinking" });

    const chunker = new SentenceChunker();
    const voiceId = session.activeVoiceId || this.deps.defaultVoiceId;
    let assistant = "";

    try {
      for await (const token of this.deps.brainProvider.stream(session.history, userText)) {
        if (epoch !== this.turnEpoch) return; // barge-in / superseded
        assistant += token;
        this.send({ type: "brain.token", token });
        for (const sentence of chunker.push(token)) {
          await this.speak(sentence, voiceId, epoch);
          if (epoch !== this.turnEpoch) return;
        }
      }
      const tail = chunker.flush();
      if (tail) await this.speak(tail, voiceId, epoch);
      if (epoch !== this.turnEpoch) return;

      this.deps.store.appendMessage(session.id, {
        role: "assistant",
        content: assistant,
      });
      this.state = "idle";
      this.send({ type: "turn.complete" });
    } catch (err) {
      if (epoch === this.turnEpoch) {
        this.sendError(`brain: ${(err as Error).message}`);
        this.state = "idle";
      }
    }
  }

  private async speak(text: string, voiceId: string, epoch: number): Promise<void> {
    if (!this.session?.speakResponses) return;
    this.state = "speaking";
    try {
      await this.deps.voiceProvider.synthesize(text, voiceId, (chunk) => {
        if (epoch !== this.turnEpoch) return;
        this.send({
          type: "tts.audio",
          mime: chunk.mime,
          audio: chunk.data.toString("base64"),
        });
      });
    } catch (err) {
      if (epoch === this.turnEpoch) this.sendError(`tts: ${(err as Error).message}`);
    }
  }

  private cleanup(): void {
    this.turnEpoch += 1;
    if (this.transcriber) {
      void this.transcriber.stop().catch(() => undefined);
      this.transcriber = null;
    }
  }
}

export function attachRealtime(server: HttpServer, deps: RealtimeDeps): WebSocketServer {
  // noServer + manual upgrade so we own the path and can reuse the HTTP server.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { url } = req;
    if (!url) {
      socket.destroy();
      return;
    }
    const path = url.split("?")[0];
    if (path !== "/realtime") {
      socket.destroy();
      return;
    }
    // TODO(v1): validate Entra ID token from the query string / header here.
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = new URL(url, "http://localhost").searchParams.get("sessionId");
      new Connection(ws, deps, sessionId);
    });
  });

  return wss;
}
