import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Preset orb colors. The first is the default "arc-reactor" blue. */
export const ORB_PRESETS: { name: string; value: string }[] = [
  { name: "Ember", value: "#ff9e3d" },
  { name: "Stark Gold", value: "#ffb347" },
  { name: "Arc Blue", value: "#39c6ff" },
  { name: "Emerald", value: "#34e0a1" },
  { name: "Violet", value: "#9d7bff" },
  { name: "Crimson", value: "#ff5d6c" },
  { name: "Ice White", value: "#dfe9ff" },
];

const STORAGE_KEY = "jarvis.orbColor";
const DEFAULT_COLOR = ORB_PRESETS[0].value;

type ThemeContextValue = {
  orbColor: string;
  setOrbColor: (hex: string) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [orbColor, setOrbColorState] = useState<string>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_COLOR;
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_COLOR;
  });

  const setOrbColor = useCallback((hex: string) => {
    setOrbColorState(hex);
    try {
      localStorage.setItem(STORAGE_KEY, hex);
    } catch {
      /* storage may be unavailable (private mode) — keep in-memory only */
    }
    // TODO(v1): also persist to session config via PATCH /sessions/{id}
  }, []);

  // Expose the color as a CSS variable for non-canvas accents (buttons, glow).
  useEffect(() => {
    document.documentElement.style.setProperty("--orb-color", orbColor);
  }, [orbColor]);

  const value = useMemo(() => ({ orbColor, setOrbColor }), [orbColor, setOrbColor]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
