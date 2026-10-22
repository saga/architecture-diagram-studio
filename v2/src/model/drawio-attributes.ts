import { encodeDrawioXmlAttribute } from "./drawio-xml-dom";

/**
 * Attribute-level helpers for native Draw.io XML.
 *
 * Cell `value` attributes may contain HTML labels whose own `style='…'` text looks
 * like a cell style attribute. Every reader therefore walks real tag attributes
 * left to right instead of searching the tag with a `style=` regular expression.
 */
export interface XmlAttributeMatch {
  /** Offset of the attribute value inside the tag, quotes excluded. */
  index: number;
  /** Length of the attribute value, quotes excluded. */
  length: number;
  value: string;
  quote: string;
}

/** Finds an attribute inside one start tag, skipping quoted values that contain markup. */
export function findXmlAttribute(tag: string, name: string): XmlAttributeMatch | null {
  if (!tag.startsWith("<")) return null;
  let i = 1;
  while (i < tag.length && !/[\s/>]/.test(tag[i])) i++;
  while (i < tag.length) {
    while (i < tag.length && /\s/.test(tag[i])) i++;
    if (tag[i] === ">" || tag[i] === "/" || i >= tag.length) break;
    const nameStart = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i])) i++;
    const attributeName = tag.slice(nameStart, i);
    while (i < tag.length && /\s/.test(tag[i])) i++;
    if (tag[i] !== "=") continue;
    i++;
    while (i < tag.length && /\s/.test(tag[i])) i++;
    const quote = tag[i];
    if (quote === '"' || quote === "'") {
      const valueStart = ++i;
      while (i < tag.length && tag[i] !== quote) i++;
      const value = tag.slice(valueStart, i);
      if (attributeName === name) return { index: valueStart, length: value.length, value, quote };
      i++;
      continue;
    }
    const valueStart = i;
    while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
    if (attributeName === name) return { index: valueStart, length: i - valueStart, value: tag.slice(valueStart, i), quote: "" };
  }
  return null;
}

/** `&amp;` is decoded last so `&amp;lt;` stays text instead of turning into markup. */
export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function encodeXmlAttribute(value: string): string {
  return encodeDrawioXmlAttribute(value);
}

/** Replaces one attribute value in place, quoting it with double quotes. */
export function replaceXmlAttribute(tag: string, name: string, value: string): string {
  const match = findXmlAttribute(tag, name);
  const encoded = encodeXmlAttribute(value);
  if (!match) return tag.slice(0, -1) + " " + name + '="' + encoded + '">';
  const prefix = tag.slice(0, match.index);
  const suffix = tag.slice(match.index + match.length);
  return prefix + encoded + suffix;
}
