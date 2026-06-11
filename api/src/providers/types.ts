/**
 * Provider abstractions. Voice (STT/TTS) and Brain (LLM) both sit behind these
 * interfaces so concrete implementations are swappable without touching the
 * orchestrator (see JARVIS-AZURE-PLAN.md §2.4, §5).
 */

export interface Voice {
  id: string;
  name: string;
  locale: string;
  gender: "Male" | "Female" | "Neutral";
  styles: string[];
}

/**
 * A push-stream transcriber: the caller feeds raw PCM audio frames as they
 * arrive and receives partial + final transcripts via callbacks.
 */
export interface Transcriber {
  start(): void;
  pushAudio(chunk: Buffer): void;
  stop(): Promise<void>;
}

export interface TranscriberCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (err: Error) => void;
}

/** A single chunk of synthesized audio plus its MIME type. */
export interface AudioChunk {
  data: Buffer;
  mime: string;
}

export interface VoiceProvider {
  listVoices(): Promise<Voice[]>;
  createTranscriber(cb: TranscriberCallbacks): Transcriber;
  /**
   * Streaming TTS. Audio is delivered to onAudioChunk as it is synthesized so
   * playback can begin before the full utterance is rendered.
   */
  synthesize(
    text: string,
    voiceId: string,
    onAudioChunk: (chunk: AudioChunk) => void,
  ): Promise<void>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BrainProvider {
  /** Stream the assistant's reply token-by-token for the given turn. */
  stream(history: ChatMessage[], userText: string): AsyncIterable<string>;
}
