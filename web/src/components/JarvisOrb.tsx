import { useEffect, useRef } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  /** Hex color, e.g. "#ff9e3d". */
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
 * "Presence" orb: a swarm of glowing particles around a hot core. Each particle
 * follows its own random path — it orbits the centre about a randomly-oriented
 * axis at its own speed — so the dots drift along independent trajectories
 * rather than sitting on a fixed lattice. No dot-to-dot links.
 */
export default function JarvisOrb({ color, state, amplitude = 0, size = 320 }: Props) {
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
    const baseR = size * 0.4;
    const focal = 2.7; // perspective focal length, in sphere-radius units

    // ---- Build particles -------------------------------------------------
    // Each particle starts on the unit sphere and rotates about its own random
    // axis. Using Rodrigues' formula with precomputed terms, its animated
    // position is: v·cosθ + (k×v)·sinθ + k(k·v)(1-cosθ), θ = phase + speed·clock.
    const N = 540;
    type P = {
      // base vector v
      vx: number;
      vy: number;
      vz: number;
      // k × v
      cx: number;
      cy: number;
      cz: number;
      // k * (k·v)
      kx: number;
      ky: number;
      kz: number;
      speed: number;
      phase: number;
      wob: number; // radial wobble frequency
      hot: boolean;
    };

    const rand = () => Math.random();
    const unit = (): [number, number, number] => {
      const u = rand() * 2 - 1;
      const ph = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      return [s * Math.cos(ph), s * Math.sin(ph), u];
    };

    const parts: P[] = [];
    for (let i = 0; i < N; i++) {
      const [vx, vy, vz] = unit();
      const [kx, ky, kz] = unit();
      const kdv = kx * vx + ky * vy + kz * vz;
      // k × v
      const cxv = ky * vz - kz * vy;
      const cyv = kz * vx - kx * vz;
      const czv = kx * vy - ky * vx;
      parts.push({
        vx,
        vy,
        vz,
        cx: cxv,
        cy: cyv,
        cz: czv,
        kx: kx * kdv,
        ky: ky * kdv,
        kz: kz * kdv,
        speed: (rand() < 0.5 ? -1 : 1) * (0.1 + rand() * 0.4),
        phase: rand() * Math.PI * 2,
        wob: 0.4 + rand() * 1.2,
        hot: rand() < 0.12,
      });
    }

    let raf = 0;
    let smoothAmp = 0;
    let clock = 0;
    let lastT = 0;

    const render = (tms: number) => {
      const { color: c, state: s, amplitude: amp } = props.current;
      const [r, g, b] = hexToRgb(c);
      const col = (a: number) => `rgba(${r},${g},${b},${a})`;
      const time = tms / 1000;

      smoothAmp += (amp - smoothAmp) * 0.18;
      const breathe = 0.5 + 0.5 * Math.sin(time * 0.9);

      // Per-state energy: drift rate, glow boost, outward swell.
      let rate: number;
      let boost: number;
      let swell: number;
      switch (s) {
        case "listening":
          rate = 1.4 + smoothAmp * 2.5;
          boost = 0.2 + smoothAmp * 0.9;
          swell = smoothAmp * 0.06;
          break;
        case "thinking":
          rate = 2.8;
          boost = 0.45 + 0.1 * Math.sin(time * 7);
          swell = 0.03;
          break;
        case "speaking":
          rate = 1.3 + smoothAmp * 2.0;
          boost = 0.3 + smoothAmp * 1.0;
          swell = 0.06 + smoothAmp * 0.34; // swarm pushes outward
          break;
        default: // idle
          rate = 0.85;
          boost = 0.08 + breathe * 0.05;
          swell = 0.01 * breathe;
      }

      // Advance a rate-scaled clock (smooth even when rate changes).
      const dt = lastT ? Math.min(0.05, (tms - lastT) / 1000) : 0;
      lastT = tms;
      clock += dt * rate;

      const sphereR = baseR * (1 + swell);
      const ax = 0.42; // fixed viewing tilt about X
      const cax = Math.cos(ax);
      const sax = Math.sin(ax);

      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = "lighter";

      // Outer halo
      const halo = ctx.createRadialGradient(cx, cy, sphereR * 0.5, cx, cy, sphereR * 1.7);
      halo.addColorStop(0, col(0.16 + boost * 0.12));
      halo.addColorStop(0.5, col(0.05));
      halo.addColorStop(1, col(0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // Hot core glow
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, sphereR * 0.55);
      core.addColorStop(0, `rgba(255,244,222,${0.5 + boost * 0.35})`);
      core.addColorStop(0.25, col(0.38 + boost * 0.2));
      core.addColorStop(1, col(0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, sphereR * 0.55, 0, Math.PI * 2);
      ctx.fill();

      // Particles along their own random paths
      for (let i = 0; i < N; i++) {
        const pt = parts[i];
        const th = pt.phase + pt.speed * clock;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const omc = 1 - ct;
        // Rodrigues rotation of v about axis k
        let x = pt.vx * ct + pt.cx * st + pt.kx * omc;
        let y = pt.vy * ct + pt.cy * st + pt.ky * omc;
        let z = pt.vz * ct + pt.cz * st + pt.kz * omc;
        // gentle radial wobble so paths breathe in/out
        const rl = 1 + 0.04 * Math.sin(time * pt.wob + pt.phase);
        x *= rl;
        y *= rl;
        z *= rl;
        // viewing tilt about X
        const y2 = y * cax - z * sax;
        const z2 = y * sax + z * cax;
        const p = focal / (focal - z2);
        const sx = cx + x * sphereR * p;
        const sy = cy + y2 * sphereR * p;
        const depth = (z2 + 1) / 2; // 0 far, 1 near

        if (pt.hot) {
          const rad = size * 0.00275 * p * (0.5 + depth * 0.9);
          const al = (0.25 + depth * 0.7) * (0.7 + boost * 0.6);
          const g2 = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad * 3);
          g2.addColorStop(0, `rgba(255,246,226,${Math.min(1, al)})`);
          g2.addColorStop(0.5, col(al * 0.5));
          g2.addColorStop(1, col(0));
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.arc(sx, sy, rad * 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const rad = Math.max(0.3, size * 0.0028 * p * (0.5 + depth * 0.8));
          ctx.fillStyle = col((0.12 + depth * 0.6) * (0.7 + boost * 0.5));
          ctx.beginPath();
          ctx.arc(sx, sy, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Tangled bright core filaments (a few rotating loops)
      for (let k = 0; k < 3; k++) {
        const rr = sphereR * (0.05 + 0.045 * k);
        const ph = clock * (0.8 + k * 0.4) + k;
        ctx.strokeStyle = `rgba(255,242,216,${(0.26 - k * 0.06) * (0.6 + boost * 0.5)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let t = 0; t <= 40; t++) {
          const u = (t / 40) * Math.PI * 2;
          const px = cx + Math.cos(u + ph) * rr * (1 + 0.4 * Math.sin(u * 3 + ph));
          const py = cy + Math.sin(u - ph) * rr * (0.7 + 0.4 * Math.cos(u * 2));
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // Planetary limb — faint shell + brighter top-left highlight
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = col(0.05);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, sphereR * 1.02, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = col(0.12 + boost * 0.1);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, sphereR * 1.02, Math.PI * 0.78, Math.PI * 1.5);
      ctx.stroke();

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
