import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import {
  AudioChunk,
  Transcriber,
  TranscriberCallbacks,
  Voice,
  VoiceProvider,
} from "./types";

/**
 * Azure AI Speech adapter implementing the VoiceProvider interface.
 *  - STT: 16 kHz/16-bit/mono PCM push stream + continuous recognition.
 *  - TTS: Neural voice, 24 kHz mono MP3 output, streamed via the synthesizer's
 *    `synthesizing` event so audio starts before the sentence completes.
 * All Azure/SSML specifics stay inside this adapter (plan §2.4).
 */
export class AzureSpeechProvider implements VoiceProvider {
  private readonly speechKey: string;
  private readonly region: string;

  constructor(speechKey: string, region: string) {
    this.speechKey = speechKey;
    this.region = region;
  }

  private baseConfig(): sdk.SpeechConfig {
    return sdk.SpeechConfig.fromSubscription(this.speechKey, this.region);
  }

  /**
   * Curated set of calm en-GB neural voices. Default is en-GB-RyanNeural
   * (calm British male) per the plan §4. Returned as a stable list so the
   * provider initialises without a network round-trip; getVoicesAsync could be
   * substituted to enumerate the live catalogue.
   */
  async listVoices(): Promise<Voice[]> {
    return [
      {
        id: "en-GB-RyanNeural",
        name: "Ryan (British male)",
        locale: "en-GB",
        gender: "Male",
        styles: ["chat", "cheerful"],
      },
      {
        id: "en-GB-ThomasNeural",
        name: "Thomas (British male)",
        locale: "en-GB",
        gender: "Male",
        styles: ["calm"],
      },
      {
        id: "en-GB-SoniaNeural",
        name: "Sonia (British female)",
        locale: "en-GB",
        gender: "Female",
        styles: ["cheerful", "sad"],
      },
      {
        id: "en-GB-LibbyNeural",
        name: "Libby (British female)",
        locale: "en-GB",
        gender: "Female",
        styles: [],
      },
    ];
  }

  createTranscriber(cb: TranscriberCallbacks): Transcriber {
    const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const speechConfig = this.baseConfig();
    speechConfig.speechRecognitionLanguage = "en-GB";

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizing = (_s, e) => {
      if (e.result.text) cb.onPartial(e.result.text);
    };
    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        cb.onFinal(e.result.text);
      }
    };
    recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error && cb.onError) {
        cb.onError(new Error(e.errorDetails || "STT canceled"));
      }
    };

    let started = false;
    return {
      start: () => {
        if (started) return;
        started = true;
        recognizer.startContinuousRecognitionAsync(
          () => undefined,
          (err) => cb.onError?.(new Error(String(err))),
        );
      },
      pushAudio: (chunk: Buffer) => {
        // Copy into a fresh ArrayBuffer the SDK can own.
        const ab = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength,
        );
        pushStream.write(ab as ArrayBuffer);
      },
      stop: () =>
        new Promise<void>((resolve) => {
          pushStream.close();
          recognizer.stopContinuousRecognitionAsync(
            () => {
              recognizer.close();
              resolve();
            },
            () => {
              recognizer.close();
              resolve();
            },
          );
        }),
    };
  }

  async synthesize(
    text: string,
    voiceId: string,
    onAudioChunk: (chunk: AudioChunk) => void,
  ): Promise<void> {
    const speechConfig = this.baseConfig();
    speechConfig.speechSynthesisVoiceName = voiceId;
    speechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

    // No AudioConfig -> pull result into memory; we stream via the
    // `synthesizing` event instead so audio flows as it is rendered.
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, undefined);

    synthesizer.synthesizing = (_s, e) => {
      const audio = e.result.audioData;
      if (audio && audio.byteLength > 0) {
        onAudioChunk({ data: Buffer.from(audio), mime: "audio/mpeg" });
      }
    };

    const ssml = buildSsml(text, voiceId);

    await new Promise<void>((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          synthesizer.close();
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve();
          } else {
            reject(new Error(result.errorDetails || "TTS failed"));
          }
        },
        (err) => {
          synthesizer.close();
          reject(new Error(String(err)));
        },
      );
    });
  }
}

/**
 * Build SSML for a calm, assistant-like delivery: moderate rate, slight warmth.
 * en-GB voices vary in supported styles, so we keep prosody portable and only
 * apply rate/pitch (no mstts:express-as, which not all voices support).
 */
function buildSsml(text: string, voiceId: string): string {
  const safe = escapeXml(text);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-GB">` +
    `<voice name="${voiceId}">` +
    `<prosody rate="-6%" pitch="-2%">${safe}</prosody>` +
    `</voice></speak>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
