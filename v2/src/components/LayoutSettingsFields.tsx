import { InputNumber, Select, Switch } from "antd";
import {
  NATIVE_LAYOUT_DENSITY_PRESETS,
  nativeLayoutDensityForSpacing,
  type NativeAutoLayoutOptions,
  type NativeLayoutDensitySelection
} from "../layout/native-layout";

interface LayoutSettingsFieldsProps {
  options: NativeAutoLayoutOptions;
  onChange: (patch: Partial<NativeAutoLayoutOptions>) => void;
  /** Vertices currently selected in the native editor; relative anchoring needs 2–32 of them. */
  anchorSelectionCount: number;
  /** True while the native editor cannot accept a layout run (not ready, running, or conflicting). */
  editorBlocked: boolean;
}

/** The body of the Layout settings dialog. Extracted so the field layout is a single source of
 * truth that can be rendered without the whole workspace. */
export function LayoutSettingsFields({ options, onChange, anchorSelectionCount, editorBlocked }: LayoutSettingsFieldsProps) {
  const anchorHint = anchorSelectionCount < 2
    ? options.preserveRelativeAnchors
      ? "Default is on; normal layout runs until at least 2 vertices are selected."
      : "Select at least 2 vertices to enable relative anchoring."
    : anchorSelectionCount > 32
      ? options.preserveRelativeAnchors
        ? "Normal layout runs with more than 32 selected; select up to 32 to anchor them."
        : "Select no more than 32 vertices."
      : anchorSelectionCount + " selected vertex(es); the set can move together.";

  const layerSpacingDisabled = !(
    options.engine === "dagre" ||
    (options.engine === "elk" && options.algorithm === "layered") ||
    (options.engine === "graphviz" && options.algorithm === "dot") ||
    (options.engine === "msagl" && options.algorithm === "layered") ||
    (options.engine === "d3" && (options.algorithm === "tree" || options.algorithm === "cluster"))
  );
  const iterationsDisabled = !(
    (options.engine === "elk" && (options.algorithm === "stress" || options.algorithm === "force")) ||
    (options.engine === "d3" && options.algorithm === "force") ||
    (options.engine === "cytoscape" && (options.algorithm === "cose" || options.algorithm === "fcose")) ||
    (options.engine === "msagl" && (options.algorithm === "mds" || options.algorithm === "ipsepcola"))
  );
  const randomSeedDisabled = !(
    (options.engine === "elk" && (options.algorithm === "stress" || options.algorithm === "force")) ||
    (options.engine === "d3" && options.algorithm === "force") ||
    (options.engine === "graphviz" && ["neato", "fdp", "sfdp"].includes(options.algorithm))
  );

  return (
    <div className="native-layout-settings">
      <section className="native-layout-settings-section">
        <h3>Containment</h3>
        <div className="native-layout-toggle-list">
          <div className="native-layout-toggle-row">
            <div className="native-layout-toggle-copy">
              <span className="native-layout-toggle-title">Preserve local grouping</span>
              <span className="native-layout-field-hint">Keeps confidently adjacent nodes together while the group moves with the new layout.</span>
            </div>
            <Switch
              aria-label="Preserve local grouping"
              checked={options.preserveLocalGrouping}
              onChange={(preserveLocalGrouping) => onChange({ preserveLocalGrouping })}
            />
          </div>
          <div className="native-layout-toggle-row">
            <div className="native-layout-toggle-copy">
              <span className="native-layout-toggle-title">Preserve relative positions of selected cells</span>
              <span className="native-layout-field-hint">{anchorHint}</span>
            </div>
            <Switch
              aria-label="Preserve relative positions of selected cells"
              checked={options.preserveRelativeAnchors}
              disabled={editorBlocked || (!options.preserveRelativeAnchors && (anchorSelectionCount < 2 || anchorSelectionCount > 32))}
              onChange={(preserveRelativeAnchors) => onChange({ preserveRelativeAnchors })}
            />
          </div>
          <div className="native-layout-toggle-row">
            <div className="native-layout-toggle-copy">
              <span className="native-layout-toggle-title">Preserve canvas origin</span>
              <span className="native-layout-field-hint">Aligns the result's content top-left with its original canvas position instead of the margin. Does not pin cells.</span>
            </div>
            <Switch
              aria-label="Preserve canvas origin"
              checked={options.preserveCanvasOrigin}
              onChange={(preserveCanvasOrigin) => onChange({ preserveCanvasOrigin })}
            />
          </div>
        </div>
      </section>

      <section className="native-layout-settings-section">
        <h3>Spacing</h3>
        <div className="native-layout-settings-grid">
          <label className="native-layout-settings-field">
            <span>Layout density</span>
            <Select<NativeLayoutDensitySelection>
              aria-label="Layout density"
              value={nativeLayoutDensityForSpacing(options.nodeSpacing, options.layerSpacing)}
              options={[
                { value: "COMPACT", label: "Compact" },
                { value: "BALANCED", label: "Balanced" },
                { value: "SPACIOUS", label: "Spacious" },
                { value: "CUSTOM", label: "Custom", disabled: true }
              ]}
              onChange={(density) => {
                if (density === "CUSTOM") return;
                onChange(NATIVE_LAYOUT_DENSITY_PRESETS[density]);
              }}
              style={{ width: "100%" }}
            />
          </label>
          <label className="native-layout-settings-field">
            <span>Canvas margin</span>
            <InputNumber aria-label="Layout canvas margin" min={0} max={300} step={10}
              value={options.margin}
              onChange={(value) => { if (typeof value === "number") onChange({ margin: value }); }}
              style={{ width: "100%" }} />
          </label>
          <label className="native-layout-settings-field">
            <span>Node spacing</span>
            <InputNumber aria-label="Node spacing" min={5} max={500} step={5}
              value={options.nodeSpacing}
              onChange={(value) => { if (typeof value === "number") onChange({ nodeSpacing: value }); }}
              style={{ width: "100%" }} />
          </label>
          <label className="native-layout-settings-field">
            <span>Layer spacing</span>
            <InputNumber aria-label="Layer spacing" min={10} max={800} step={10}
              disabled={layerSpacingDisabled}
              value={options.layerSpacing}
              onChange={(value) => { if (typeof value === "number") onChange({ layerSpacing: value }); }}
              style={{ width: "100%" }} />
          </label>
        </div>
      </section>

      <section className="native-layout-settings-section">
        <h3>Engine tuning</h3>
        <div className="native-layout-settings-grid">
          <label className="native-layout-settings-field">
            <span>Iterations</span>
            <InputNumber aria-label="ELK iterations" min={20} max={3000} step={20}
              disabled={iterationsDisabled}
              value={options.iterations}
              onChange={(value) => { if (typeof value === "number") onChange({ iterations: value }); }}
              style={{ width: "100%" }} />
          </label>
          <label className="native-layout-settings-field">
            <span>Random seed</span>
            <InputNumber aria-label="Layout random seed" min={0} max={100000} step={1}
              disabled={randomSeedDisabled}
              value={options.randomSeed}
              onChange={(value) => { if (typeof value === "number") onChange({ randomSeed: value }); }}
              style={{ width: "100%" }} />
          </label>
        </div>
      </section>

      <section className="native-layout-settings-section">
        <h3>Connector routing</h3>
        <div className="native-layout-settings-field">
          <Select<NativeAutoLayoutOptions["edgeRouting"]>
            aria-label="Connector routing"
            value={options.edgeRouting}
            options={[
              { value: "ORTHOGONAL", label: "Orthogonal" },
              { value: "POLYLINE", label: "Polyline" },
              { value: "SPLINES", label: "Curved / splines" }
            ]}
            onChange={(edgeRouting) => onChange({ edgeRouting })}
            style={{ width: "100%" }}
          />
        </div>
      </section>

      <details className="native-layout-settings-more">
        <summary>About these settings</summary>
        <dl className="native-layout-settings-notes">
          <div>
            <dt>Relative anchoring</dt>
            <dd>On by default. 2–32 selected vertices keep their pairwise direction and distance; otherwise ordinary layout runs.</dd>
          </div>
          <div>
            <dt>Local grouping</dt>
            <dd>Keeps confidently adjacent nodes together while the group moves.</dd>
          </div>
          <div>
            <dt>Canvas origin</dt>
            <dd>Keeps the result's content top-left at its original canvas position instead of the margin.</dd>
          </div>
          <div>
            <dt>Density</dt>
            <dd>Presets set node and layer spacing; Custom keeps the exact values.</dd>
          </div>
          <div>
            <dt>Routing</dt>
            <dd>Orthogonal avoids node bounds; Polyline keeps engine waypoints; Curved smooths them where supported.</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>Saved in this browser; anchor IDs apply to the current run only.</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
