import { useEffect, useRef } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  /** Hex color, e.g. "#39c6ff". */
  color: string;
  /** Current conversational state. */
  state: OrbState;
  /** Live audio level 0..1 (mic when listening, TTS when speaking). */
  amplitude?: number;
  /** Render size in CSS pixels. */
  size?: number;
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Canvas-rendered "presence" orb. Animates independently of React via rAF;
 * the latest props are read through refs so the loop never restarts.
 */
export default function JarvisOrb({ color, state, amplitude = 0, size = 280 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ color, state, amplitude });
  props.current = { color, state, amplitude };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const baseR = size * 0.28;
    let raf = 0;
    let smoothAmp = 0;

    const render = (t: number) => {
      const { color: c, state: s, amplitude: amp } = props.current;
      const [r, g, b] = hexToRgb(c);
      const rgb = (a: number) => `rgba(${r},${g},${b},${a})`;

      // Smooth the incoming amplitude so the orb glides rather than jitters.
      smoothAmp += (amp - smoothAmp) * 0.18;

      // Idle "breathing" + a slow drift used by the thinking swirl.
      const breathe = 0.5 + 0.5 * Math.sin(t / 1400);
      const time = t / 1000;

      // Per-state pulse contribution.
      let pulse = 0;
      switch (s) {
        case "idle":
          pulse = breathe * 0.06;
          break;
        case "listening":
          pulse = 0.05 + smoothAmp * 0.45;
          break;
        case "thinking":
          pulse = 0.12 + 0.06 * Math.sin(time * 6);
          break;
        case "speaking":
          pulse = 0.08 + smoothAmp * 0.5;
          break;
      }

      const radius = baseR * (1 + pulse);

      ctx.clearRect(0, 0, size, size);

      // Outer halo
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.6, cx, cy, radius * 2.4);
      halo.addColorStop(0, rgb(0.35 + pulse * 0.4));
      halo.addColorStop(0.4, rgb(0.12));
      halo.addColorStop(1, rgb(0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // Core sphere
      const core = ctx.createRadialGradient(
        cx - radius * 0.3,
        cy - radius * 0.3,
        radius * 0.1,
        cx,
        cy,
        radius,
      );
      core.addColorStop(0, "rgba(255,255,255,0.95)");
      core.addColorStop(0.25, rgb(0.95));
      core.addColorStop(0.7, rgb(0.55));
      core.addColorStop(1, rgb(0.08));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      // ---- Satellite constellation -----------------------------------------
      // The orb is the "planet"; small satellites ride several orbital shells
      // at different inclinations (like a GNSS/Starlink constellation). They
      // orbit by default (the idle/static signature); active states layer
      // brightness + a slight shell expansion on top. Satellites on the far
      // side are occluded as they pass behind the planet.
      const ringAmp = s === "listening" || s === "speaking" ? smoothAmp : breathe * 0.3;
      const focal = size * 0.95;

      // Activity multiplier: how much faster/brighter than the resting orbit.
      const act =
        s === "thinking"
          ? 2.6
          : s === "speaking"
            ? 1.0 + smoothAmp * 2.5
            : s === "listening"
              ? 1.0 + smoothAmp * 2.5
              : 1; // idle/static = gentle default orbit

      // Orbital shells: inclination, ascending-node rotation, radius, speed,
      // satellite count, phase offset.
      // All shells share the same radius (a constellation sphere) and are
      // spaced evenly: inclination is distributed across the poles and the
      // ascending node is fanned evenly around the sphere.
      const SHELL_R = 1.16;
      const RING_COUNT = 14;
      const ORBITS = Array.from({ length: RING_COUNT }, (_, i) => ({
        inc: ((i + 0.5) / RING_COUNT) * Math.PI, // evenly spaced 0..π (no poles)
        node: (i / RING_COUNT) * Math.PI * 2, // evenly fanned around
        r: SHELL_R,
        speed: (i % 2 === 0 ? 1 : -1) * (0.16 + (i % 3) * 0.04),
        count: 28,
        phase: (i / RING_COUNT) * Math.PI * 2,
      }));

      // While speaking, satellites push outward from the orb with the voice
      // level (a "breathing out" on speech); other states stay near their shell.
      const expand = s === "speaking" ? 1 + smoothAmp * 0.75 : 1;

      type Sat = { sx: number; sy: number; z: number; depth: number };
      const sats: Sat[] = [];

      for (const o of ORBITS) {
        const R = radius * o.r * (1 + ringAmp * 0.1) * expand;
        const ci = Math.cos(o.inc);
        const si = Math.sin(o.inc);
        const cn = Math.cos(o.node);
        const sn = Math.sin(o.node);

        // Faint orbit trace.
        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        for (let k = 0; k <= 72; k++) {
          const a = (k / 72) * Math.PI * 2;
          const x = Math.cos(a) * R;
          const z0 = Math.sin(a) * R;
          const y1 = -z0 * si;
          const z1 = z0 * ci;
          const x2 = x * cn + z1 * sn;
          const z2 = -x * sn + z1 * cn;
          const pp = focal / (focal - z2);
          const px = cx + x2 * pp;
          const py = cy + y1 * pp;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = rgb(0.05 + ringAmp * 0.05);
        ctx.lineWidth = 1;
        ctx.stroke();

        // Satellites on this shell.
        for (let i = 0; i < o.count; i++) {
          const a = (i / o.count) * Math.PI * 2 + time * o.speed * act + o.phase;
          const x = Math.cos(a) * R;
          const z0 = Math.sin(a) * R;
          const y1 = -z0 * si;
          const z1 = z0 * ci;
          const x2 = x * cn + z1 * sn;
          const z2 = -x * sn + z1 * cn;
          const pp = focal / (focal - z2);
          const sx = cx + x2 * pp;
          const sy = cy + y1 * pp;

          // Occlude satellites passing behind the planet.
          const behind = z2 < 0;
          if (behind && Math.hypot(sx - cx, sy - cy) < radius * 0.95) continue;

          sats.push({ sx, sy, z: z2, depth: (z2 / R + 1) / 2 });
        }
      }

      // Draw back-to-front so nearer satellites overlap farther ones.
      sats.sort((p, q) => p.z - q.z);
      ctx.globalCompositeOperation = "lighter";
      for (const st of sats) {
        const pp = focal / (focal - st.z);
        const dotR = Math.max(0.15, size * 0.0015 * pp * (0.5 + st.depth * 0.7));
        const alpha = (0.3 + st.depth * 0.6) * (0.7 + ringAmp * 0.5);

        // Small glow.
        const g = ctx.createRadialGradient(st.sx, st.sy, 0, st.sx, st.sy, dotR * 3.2);
        g.addColorStop(0, rgb(Math.min(1, alpha)));
        g.addColorStop(0.5, rgb(alpha * 0.4));
        g.addColorStop(1, rgb(0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(st.sx, st.sy, dotR * 3.2, 0, Math.PI * 2);
        ctx.fill();

        // Bright satellite point.
        ctx.fillStyle = `rgba(255,255,255,${0.45 + st.depth * 0.5})`;
        ctx.beginPath();
        ctx.arc(st.sx, st.sy, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      aria-label={`Jarvis is ${state}`}
      role="img"
    />
  );
}
