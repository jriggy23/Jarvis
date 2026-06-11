import { useCallback, useEffect, useRef, useState } from "react";
import JarvisOrb, { type OrbState } from "./components/JarvisOrb";
import OrbColorPicker from "./components/OrbColorPicker";
import { useTheme } from "./theme";

export default function App() {
  const { orbColor } = useTheme();
  const [state, setState] = useState<OrbState>("idle");
  const [amplitude, setAmplitude] = useState(0);
  const [text, setText] = useState("");

  // --- Live mic amplitude (dev stand-in for the STT stream) -----------------
  const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream; raf: number } | null>(null);

  const stopMic = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    a.stream.getTracks().forEach((t) => t.stop());
    a.ctx.close();
    audioRef.current = null;
    setAmplitude(0);
  }, []);

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setAmplitude(Math.min(1, rms * 3));
        const raf = requestAnimationFrame(tick);
        if (audioRef.current) audioRef.current.raf = raf;
      };
      const raf = requestAnimationFrame(tick);
      audioRef.current = { ctx, stream, raf };
    } catch {
      // Mic denied/unavailable — fall back to a gentle simulated level.
      setAmplitude(0.2);
    }
  }, []);

  const toggleListen = useCallback(() => {
    setState((s) => {
      if (s === "listening") {
        stopMic();
        return "idle";
      }
      startMic();
      return "listening";
    });
  }, [startMic, stopMic]);

  useEffect(() => () => stopMic(), [stopMic]);

  const stateLabel: Record<OrbState, string> = {
    idle: "Ready",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  };

  return (
    <div className="app">
      <header className="app__header">
        <span className="brand">JARVIS</span>
      </header>

      <main className="stage">
        <button
          className="orb-button"
          onClick={toggleListen}
          aria-label={state === "listening" ? "Stop listening" : "Start listening"}
        >
          <JarvisOrb color={orbColor} state={state} amplitude={amplitude} size={300} />
        </button>
        <p className="state-label" style={{ color: orbColor }}>
          {stateLabel[state]}
        </p>
      </main>

      <footer className="controls">
        <OrbColorPicker />

        <form
          className="input-bar"
          onSubmit={(e) => {
            e.preventDefault();
            // TODO(v1): send over WS / POST /sessions/{id}/messages
            setText("");
          }}
        >
          <input
            type="text"
            placeholder="Type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={!text.trim()}>
            Send
          </button>
        </form>

        {/* Dev-only state switcher to preview each look */}
        <div className="state-switcher" aria-label="Preview states">
          {(["idle", "listening", "thinking", "speaking"] as OrbState[]).map((s) => (
            <button
              key={s}
              className={state === s ? "active" : ""}
              onClick={() => {
                if (s !== "listening") stopMic();
                setState(s);
                if (s === "listening") startMic();
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
