import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export type DrawioDomDocument = Document;
export type DrawioDomElement = Element;

export interface DrawioXmlParseOptions {
  rejectDtd?: boolean;
}

/** The single XML parsing boundary for Draw.io source, import, validation and theme utilities. */
export function parseDrawioXml(xml: string, options: DrawioXmlParseOptions = {}): DrawioDomDocument {
  if (options.rejectDtd !== false) {
    const withoutSafeRegions = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
      .replace(/<\?[\s\S]*?\?>/g, "");
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(withoutSafeRegions)) {
      throw new Error("DTD and custom entity declarations are not supported.");
    }
  }
  const errors: string[] = [];
  const parsed = new DOMParser({
    locator: false,
    onError: (level, message) => { if (level !== "warning") errors.push(message); }
  }).parseFromString(xml, "application/xml");
  if (errors.length) throw new Error(errors.slice(0, 5).join("; "));
  if (!parsed.documentElement) throw new Error("The XML document has no root element.");
  return parsed as unknown as DrawioDomDocument;
}

/** XMLSerializer is the only serializer for DOM-backed XML mutations. */
export function serializeDrawioXml(node: Node): string {
  return new XMLSerializer().serializeToString(node as unknown as Parameters<InstanceType<typeof XMLSerializer>["serializeToString"]>[0]);
}

export function encodeDrawioXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function findDrawioElements(document: DrawioDomDocument, tagName: string): DrawioDomElement[] {
  const nodes = document.getElementsByTagName(tagName);
  const result: DrawioDomElement[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node) result.push(node as unknown as DrawioDomElement);
  }
  return result;
}
