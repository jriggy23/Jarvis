import { ORB_PRESETS, useTheme } from "../theme";

/**
 * Orb color selector: preset swatches + a custom color input.
 * Selection is persisted via the theme store (localStorage today,
 * session config later).
 */
export default function OrbColorPicker() {
  const { orbColor, setOrbColor } = useTheme();
  const isPreset = ORB_PRESETS.some((p) => p.value.toLowerCase() === orbColor.toLowerCase());

  return (
    <div className="color-picker" role="group" aria-label="Orb color">
      <span className="color-picker__label">Orb color</span>

      <div className="color-picker__swatches">
        {ORB_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={
              "swatch" + (p.value.toLowerCase() === orbColor.toLowerCase() ? " swatch--active" : "")
            }
            style={{ background: p.value }}
            title={p.name}
            aria-label={p.name}
            aria-pressed={p.value.toLowerCase() === orbColor.toLowerCase()}
            onClick={() => setOrbColor(p.value)}
          />
        ))}

        {/* Custom color */}
        <label
          className={"swatch swatch--custom" + (!isPreset ? " swatch--active" : "")}
          title="Custom color"
        >
          <span className="swatch__plus" aria-hidden>
            +
          </span>
          <input
            type="color"
            value={orbColor}
            onChange={(e) => setOrbColor(e.target.value)}
            aria-label="Custom orb color"
          />
        </label>
      </div>
    </div>
  );
}
