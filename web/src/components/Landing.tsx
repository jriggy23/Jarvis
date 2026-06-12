import { useCallback, useEffect, useRef, useState } from "react";
import JarvisOrb from "./JarvisOrb";
import { useTheme } from "../theme";

/** Path to the boot greeting audio. File lives at web/public/welcome.mp3. */
const WELCOME_AUDIO_SRC = "/welcome.mp3";

type Props = {
  onEnter: () => void;
};

/**
 * Initial landing / boot screen: "Welcome to Jarvis" with the orb and a boot
 * greeting sound. The app advances ONLY once the greeting has finished playing
 * (its `ended` event) — never on a fixed timer — so the clip is never cut off.
 *
 * Browsers block autoplay-with-audio until a user gesture, so we attempt
 * autoplay on mount and, if blocked, play on the first tap. A safety fallback
 * advances anyway if the audio can't play or never reports `ended`.
 */
export default function Landing({ onEnter }: Props) {
  const { orbColor } = useTheme();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fallbackRef = useRef<number | undefined>(undefined);
  const doneRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [needTap, setNeedTap] = useState(false);
  const [playing, setPlaying] = useState(false);

  /** Begin the fade-out, then hand off to the app (guarded to run once). */
  const leave = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (fallbackRef.current) window.clearTimeout(fallbackRef.current);
    setLeaving(true);
    window.setTimeout(onEnter, 700);
  }, [onEnter]);

  /** Play the greeting and arm a safety timer in case `ended` never fires. */
  const startPlayback = useCallback(
    (audio: HTMLAudioElement) => {
      audio
        .play()
        .then(() => {
          setPlaying(true);
          setNeedTap(false);
          const dur = audio.duration;
          const ms = Number.isFinite(dur) && dur > 0 ? dur * 1000 + 1500 : 12000;
          fallbackRef.current = window.setTimeout(leave, ms);
        })
        .catch(() => {
          // Autoplay blocked — wait for a tap (handled in enter()).
          setNeedTap(true);
        });
    },
    [leave],
  );

  useEffect(() => {
    const audio = new Audio(WELCOME_AUDIO_SRC);
    audio.preload = "auto";
    audioRef.current = audio;

    const onEnded = () => leave();
    // If the file is missing/undecodable, don't strand the user — advance.
    const onError = () => window.setTimeout(leave, 400);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    // Best-effort autoplay; falls back to tap if the browser blocks it.
    startPlayback(audio);

    return () => {
      if (fallbackRef.current) window.clearTimeout(fallbackRef.current);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.pause();
      audioRef.current = null;
    };
  }, [leave, startPlayback]);

  /** Tap/Enter: start the greeting if it hasn't begun. If already playing, let
   *  it finish (no skip) — the app advances on `ended`. */
  const enter = useCallback(() => {
    if (doneRef.current || playing) return;
    const audio = audioRef.current;
    if (!audio) {
      leave();
      return;
    }
    startPlayback(audio);
  }, [playing, leave, startPlayback]);

  const hint = playing ? "Initialising…" : needTap ? "Tap to begin" : "Loading…";

  return (
    <div
      className={"landing" + (leaving ? " landing--leaving" : "")}
      role="button"
      tabIndex={0}
      aria-label="Enter Jarvis"
      onClick={enter}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") enter();
      }}
    >
      <div className="landing__orb">
        <JarvisOrb
          color={orbColor}
          state={playing ? "speaking" : "idle"}
          amplitude={playing ? 0.5 : 0}
          size={300}
        />
      </div>

      <h1 className="landing__title">Welcome to Jarvis</h1>

      <p className="landing__hint" style={{ color: orbColor }}>
        {hint}
      </p>
    </div>
  );
}
