import { useMemo } from "react";

type PropertyEdit = (cellId: string, path: string, value: string) => void;
interface Props { xml: string; cellId: string | null; onEdit: PropertyEdit; }

interface CellProperties {
  wrapper: Element | null;
  cell: Element;
  geometry: Element | null;
  label: string;
  style: string;
}
function readCellProperties(xml: string, cellId: string): CellProperties | null {
  try {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    if (parsed.querySelector("parsererror")) return null;
    const candidate = Array.from(parsed.querySelectorAll("[id]")).find((element) =>
      element.getAttribute("id") === cellId && (element.localName === "mxCell" || !!element.querySelector("mxCell"))
    );
    if (!candidate) return null;
    const cell = candidate.localName === "mxCell" ? candidate : candidate.querySelector("mxCell");
    if (!cell) return null;
    const wrapper = candidate === cell ? null : candidate;
    const geometry = cell.querySelector(":scope > mxGeometry");
    return {
      wrapper, cell, geometry,
      label: wrapper?.getAttribute("label") ?? cell.getAttribute("value") ?? "",
      style: cell.getAttribute("style") ?? ""
    };
  } catch { return null; }
}
function attributes(element: Element | null): Array<[string, string]> {
  return element ? Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]) : [];
}
function styleTokens(style: string): Array<[string, string]> {
  const tokens: Array<[string, string]> = [];
  for (const part of style.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) tokens.push([part.slice(0, index).trim(), part.slice(index + 1).trim()]);
  }
  return tokens;
}
function Field({ label, value, onChange, multiline = false, readOnly = false }: {
  label: string; value: string; onChange?: (value: string) => void; multiline?: boolean; readOnly?: boolean;
}) {
  return <label className="native-property-field">
    <span>{label}</span>
    {multiline
      ? <textarea key={label + ":" + value} className="text-field text-area" defaultValue={value} readOnly={readOnly} rows={3} onBlur={(event) => onChange?.(event.currentTarget.value)} />
      : <input key={label + ":" + value} className="text-field" defaultValue={value} readOnly={readOnly} onBlur={(event) => onChange?.(event.currentTarget.value)} />}
  </label>;
}

/** Reads properties from the authoritative native Draw.io XML, not the lossy semantic projection. */
export default function NativeSelectionInspector({ xml, cellId, onEdit }: Props) {
  const properties = useMemo(() => cellId ? readCellProperties(xml, cellId) : null, [xml, cellId]);
  if (!cellId) return <div className="empty-inspector">Select an element or connector in the Draw.io canvas to inspect its native properties.</div>;
  if (!properties) return <div className="empty-inspector">Selected cell <code>{cellId}</code> is not present in the current XML projection. Its native XML remains unchanged.</div>;

  const { wrapper, cell, geometry, label, style } = properties;
  const wrapperAttrs = attributes(wrapper).filter(([name]) => name !== "id" && name !== "label");
  const cellAttrs = attributes(cell).filter(([name]) => !["id", "value", "style", "parent", "source", "target"].includes(name));
  const geometryAttrs = attributes(geometry).filter(([name]) => name !== "as");
  const tokens = styleTokens(style);
  const update = (path: string) => (value: string) => onEdit(cellId, path, value);
  const updateToken = (key: string, value: string) => {
    const next = new Map(styleTokens(style));
    if (value === "") next.delete(key); else next.set(key, value);
    const raw = style.split(";").filter((part) => part && !part.includes("=")).join(";");
    const serialized = [...Array.from(next, ([name, item]) => name + "=" + item), raw].filter(Boolean).join(";");
    update("style")(serialized ? serialized + ";" : "");
  };

  return <section className="native-inspector">
    <div className="native-inspector-heading">
      <strong>{cell.getAttribute("edge") === "1" ? "Connector properties" : cell.getAttribute("vertex") === "1" ? "Element properties" : "Cell properties"}</strong>
      <code title={cellId}>{cellId}</code>
    </div>
    <div className="native-inspector-group">
      <div className="field-label">Content</div>
      <Field label={wrapper?.hasAttribute("label") ? "Label" : "Value"} value={label} onChange={update("label")} multiline />
      <Field label="Style (Draw.io)" value={style} onChange={update("style")} multiline />
    </div>
    {geometry && <div className="native-inspector-group">
      <div className="field-label">Geometry</div>
      {(["x", "y", "width", "height", "relative"] as const).filter((key) => geometry.hasAttribute(key)).map((key) =>
        <Field key={key} label={key} value={geometry.getAttribute(key) ?? ""} onChange={update("geometry:" + key)} />
      )}
      {geometryAttrs.filter(([key]) => !["x", "y", "width", "height", "relative"].includes(key)).map(([key, value]) =>
        <Field key={key} label={"geometry." + key} value={value} readOnly />
      )}
    </div>}
    {tokens.length > 0 && <details className="native-inspector-group" open>
      <summary className="field-label">Style properties · {tokens.length}</summary>
      {tokens.map(([key, value], index) =>
        <Field key={key + ":" + index} label={key} value={value} onChange={(next) => updateToken(key, next)} />
      )}
    </details>}
    {wrapperAttrs.length > 0 && <details className="native-inspector-group" open>
      <summary className="field-label">Custom attributes · {wrapperAttrs.length}</summary>
      {wrapperAttrs.map(([key, value]) =>
        <Field key={key} label={key} value={value} onChange={update("valueAttr:" + key)} />
      )}
    </details>}
    {cellAttrs.length > 0 && <details className="native-inspector-group">
      <summary className="field-label">Cell attributes · {cellAttrs.length}</summary>
      {cellAttrs.map(([key, value]) =>
        <Field key={key} label={key} value={value} readOnly />
      )}
    </details>}
    <div className="native-inspector-group">
      <div className="field-label">Cell references</div>
      {(["parent", "source", "target"] as const).filter((key) => cell.hasAttribute(key)).map((key) =>
        <Field key={key} label={key} value={cell.getAttribute(key) ?? ""} onChange={update("cell:" + key)} />
      )}
      <Field label="id" value={cellId} readOnly />
    </div>
  </section>;
}
