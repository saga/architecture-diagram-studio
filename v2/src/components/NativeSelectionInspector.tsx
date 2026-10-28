import { useMemo } from "react";
import { decodeDrawioPageXml } from "../model/drawio-xml-schema";

type PropertyEdit = (cellId: string, path: string, value: string, pageId: string | null) => void;
interface Props { xml: string; cellId: string | null; pageId: string | null; onEdit: PropertyEdit; }

interface CellProperties {
  wrapper: Element | null;
  cell: Element;
  geometry: Element | null;
  label: string;
  style: string;
  points: Array<{ x: string; y: string }>;
  nestedGeometry: Array<{ name: string; attributes: Array<[string, string]> }>;
}
function readCellProperties(xml: string, cellId: string, pageId: string | null): CellProperties | null {
  try {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    if (parsed.querySelector("parsererror")) return null;
    const root = parsed.documentElement;
    const models: Element[] = [];
    if (root.localName === "mxGraphModel") models.push(root);
    else if (root.localName === "mxfile") {
      const pages = Array.from(root.children).filter((element) => element.localName === "diagram");
      // With multiple pages, a missing active-page ID must not turn the inspector into
      // a document-wide search: cell IDs can repeat across pages and edits are page-scoped.
      if (pageId === null && pages.length !== 1) return null;
      const activePages = pageId !== null ? pages.filter((page) => page.getAttribute("id") === pageId) : pages;
      // An explicit page ID is authoritative. Never fall back to another page when it is missing.
      for (const page of activePages) {
        const inlineModel = Array.from(page.children).find((element) => element.localName === "mxGraphModel");
        if (inlineModel) {
          models.push(inlineModel);
          continue;
        }
        const payload = page.textContent?.trim() ?? "";
        if (!payload) continue;
        try {
          const decoded = decodeDrawioPageXml(payload);
          const modelDocument = new DOMParser().parseFromString(decoded, "application/xml");
          if (!modelDocument.querySelector("parsererror") && modelDocument.documentElement.localName === "mxGraphModel") {
            models.push(modelDocument.documentElement);
          }
        } catch { /* The schema validator reports malformed compressed pages elsewhere. */ }
      }
    }
    const matches: CellProperties[] = [];
    for (const model of models) {
      const candidate = Array.from(model.querySelectorAll("[id]")).find((element) =>
        element.getAttribute("id") === cellId && (element.localName === "mxCell" || !!element.querySelector("mxCell"))
      );
      if (!candidate) continue;
      const cell = candidate.localName === "mxCell" ? candidate : candidate.querySelector("mxCell");
      if (!cell) continue;
      const wrapper = candidate === cell ? null : candidate;
      const geometry = Array.from(cell.children).find((element) => element.localName === "mxGeometry") ?? null;
      const pointArray = geometry && Array.from(geometry.children).find((element) => element.localName === "Array" && element.getAttribute("as") === "points");
      const points = pointArray ? Array.from(pointArray.children).filter((element) => element.localName === "mxPoint")
        .map((point) => ({ x: point.getAttribute("x") ?? "", y: point.getAttribute("y") ?? "" })) : [];
      const nestedGeometry = geometry ? Array.from(geometry.children).flatMap((element) => {
        if (element === pointArray) {
          const details: Array<{ name: string; attributes: Array<[string, string]> }> = [];
          const arrayAttributes = attributes(element).filter(([key]) => key !== "as");
          if (arrayAttributes.length) details.push({ name: "Array as=points", attributes: arrayAttributes });
          Array.from(element.children).forEach((point, index) => {
            const extraAttributes = attributes(point).filter(([key]) => key !== "x" && key !== "y");
            if (extraAttributes.length) details.push({ name: "points[" + index + "]", attributes: extraAttributes });
          });
          return details;
        }
        return [{ name: element.localName, attributes: attributes(element) }];
      }) : [];
      matches.push({
        wrapper, cell, geometry, points, nestedGeometry,
        label: displayLabel(wrapper?.getAttribute("label") ?? wrapper?.getAttribute("value") ?? cell.getAttribute("value") ?? ""),
        style: cell.getAttribute("style") ?? ""
      });
    }
    return matches.length === 1 ? matches[0] : null;
  } catch { return null; }
}
function displayLabel(value: string): string {
  if (!/<[a-z][^>]*>/i.test(value)) return value;
  try {
    const parsed = new DOMParser().parseFromString(value, "text/html");
    return (parsed.body.textContent ?? value).trim();
  } catch { return value; }
}
function attributes(element: Element | null): Array<[string, string]> {
  return element ? Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value] as [string, string]) : [];
}
function styleTokens(style: string): Array<[string, string]> {
  const tokens: Array<[string, string]> = [];
  for (const part of style.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) tokens.push([part.slice(0, index).trim(), part.slice(index + 1).trim()]);
    else if (part.trim()) tokens.push([part.trim(), "1"]);
  }
  return tokens;
}
function isStructuralRootOrLayer(cell: Element, model: Element): boolean {
  if (cell.getAttribute("vertex") === "1" || cell.getAttribute("edge") === "1") return false;
  if (Array.from(cell.children).some((child) => child.localName === "mxGeometry")) return false;
  const parentId = cell.getAttribute("parent");
  if (!parentId) return cell === Array.from(model.querySelectorAll("root > mxCell")).find((candidate) => !candidate.hasAttribute("parent"));
  const root = Array.from(model.querySelectorAll("root > mxCell")).find((candidate) => !candidate.hasAttribute("parent"));
  return !!root && parentId === root.getAttribute("id");
}
function Field({ label, value, onChange, multiline = false, readOnly = false }: {
  label: string; value: string; onChange?: (value: string) => void; multiline?: boolean; readOnly?: boolean;
}) {
  return <label className="native-property-field">
    <span>{label}</span>
    {multiline
      ? <textarea key={label + ":" + value} className="text-field text-area" defaultValue={value} readOnly={readOnly} rows={3} onBlur={(event) => { if (event.currentTarget.value !== value) onChange?.(event.currentTarget.value); }} />
      : <input key={label + ":" + value} className="text-field" defaultValue={value} readOnly={readOnly} onBlur={(event) => { if (event.currentTarget.value !== value) onChange?.(event.currentTarget.value); }} />}
  </label>;
}

/** Reads and edits properties directly from the selected native Draw.io cell. */
export default function NativeSelectionInspector({ xml, cellId, pageId, onEdit }: Props) {
  const properties = useMemo(() => cellId ? readCellProperties(xml, cellId, pageId) : null, [xml, cellId, pageId]);
  if (!cellId) return <div className="empty-inspector">Select an element or connector in the Draw.io canvas to inspect its native properties.</div>;
  if (!properties) return <div className="empty-inspector">Selected cell <code>{cellId}</code> was not found unambiguously in the current native XML. No changes have been made.</div>;

  const { wrapper, cell, geometry, label, style, points, nestedGeometry } = properties;
  const wrapperAttrs = attributes(wrapper).filter(([name]) => name !== "id" && name !== "label" && !(name === "value" && !wrapper?.hasAttribute("label")));
  const cellAttrs = attributes(cell).filter(([name]) => !["id", "value", "style", "parent", "source", "target"].includes(name));
  const geometryAttrs = attributes(geometry).filter(([name]) => name !== "as");
  const tokens = styleTokens(style);
  const update = (path: string) => (value: string) => onEdit(cellId, path, value, pageId);
  const updateToken = (key: string, value: string) => {
    // Patch one key against the live Draw.io model so quick edits to different style
    // fields cannot overwrite each other while the XML autosave is still in flight.
    update("style:" + key)(value);
  };
  const parentId = cell.getAttribute("parent");
  const rootCell = cell.ownerDocument.querySelector("root > mxCell:not([parent])");
  const parentIsStructuralRoot = !!rootCell && parentId === rootCell.getAttribute("id");
  const structuralParentCell = parentId
    ? Array.from(cell.ownerDocument.querySelectorAll("mxCell")).find((candidate) => candidate.getAttribute("id") === parentId) ?? null
    : null;
  const parentIsStructuralLayer = !!structuralParentCell && isStructuralRootOrLayer(structuralParentCell, cell.ownerDocument.documentElement);
  const parentReadOnly = isStructuralRootOrLayer(cell, cell.ownerDocument.documentElement) || parentIsStructuralRoot || parentIsStructuralLayer;

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
      <Field label="geometry.as" value={geometry.getAttribute("as") ?? ""} readOnly />
      {(["x", "y", "width", "height", "relative"] as const).filter((key) => geometry.hasAttribute(key)).map((key) =>
        <Field key={key} label={key} value={geometry.getAttribute(key) ?? ""} onChange={update("geometry:" + key)} />
      )}
      {geometryAttrs.filter(([key]) => !["x", "y", "width", "height", "relative"].includes(key)).map(([key, value]) =>
        <Field key={key} label={"geometry." + key} value={value} readOnly />
      )}
      {points.map((point, index) => <div className="native-property-point" key={index}>
        <div className="field-label">Connector control point {index + 1}</div>
        <Field label="x" value={point.x} onChange={update("point:" + index + ":x")} />
        <Field label="y" value={point.y} onChange={update("point:" + index + ":y")} />
      </div>)}
      {nestedGeometry.map((item, index) => <details key={item.name + ":" + index} className="native-inspector-group">
        <summary className="field-label">{item.name} attributes · {item.attributes.length}</summary>
        {item.attributes.map(([key, value]) => <Field key={key} label={item.name + "." + key} value={value} readOnly />)}
      </details>)}
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
        <Field key={key} label={key} value={value}
          onChange={["visible", "collapsed", "connectable"].includes(key) ? update("cell:" + key) : undefined}
          readOnly={!["visible", "collapsed", "connectable"].includes(key)} />
      )}
    </details>}
    <div className="native-inspector-group">
      <div className="field-label">Cell references</div>
      {(["parent", "source", "target"] as const).filter((key) => cell.hasAttribute(key)).map((key) =>
        <Field key={key} label={key} value={cell.getAttribute(key) ?? ""} onChange={update("cell:" + key)} readOnly={key === "parent" && parentReadOnly} />
      )}
      <Field label="id" value={cellId} readOnly />
    </div>
  </section>;
}
