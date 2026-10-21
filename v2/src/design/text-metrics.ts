const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], [0x2e80, 0xa4cf], [0xac00, 0xd7af],
  [0xf900, 0xfaff], [0xfe10, 0xfe6f], [0xff01, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1faff]
];

export function isWideCodePoint(codePoint: number): boolean {
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function containsWideCharacters(value: string): boolean {
  return Array.from(value).some((character) => isWideCodePoint(character.codePointAt(0) ?? 0));
}

/**
 * Deterministic layout estimate shared by quality checks and the SVG canvas.
 * Wide CJK/emoji glyphs reserve one em; Latin glyphs use proportional widths.
 * It is a conservative fallback, not a replacement for browser font metrics.
 */
export function measureTextWidth(value: string, fontSize = 13): number {
  let width = 0;
  for (const character of Array.from(value.normalize("NFC"))) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)) continue;
    if (isWideCodePoint(codePoint)) {
      width += fontSize;
    } else if (/\s/u.test(character)) {
      width += fontSize * 0.34;
    } else if (/[ilI.,:;'!`|]/u.test(character)) {
      width += fontSize * 0.3;
    } else if (/[MW@#%&]/u.test(character)) {
      width += fontSize * 0.86;
    } else if (/[A-Z0-9]/u.test(character)) {
      width += fontSize * 0.62;
    } else if (/[-+*=()\[\]{}<>/?\\]/u.test(character)) {
      width += fontSize * 0.48;
    } else {
      width += fontSize * 0.56;
    }
  }
  return width;
}

export function truncateTextToWidth(value: string, maxWidth: number, fontSize = 13): string {
  if (measureTextWidth(value, fontSize) <= maxWidth) return value;
  const suffix = "…";
  const suffixWidth = measureTextWidth(suffix, fontSize);
  if (maxWidth <= suffixWidth) return suffix;
  let result = "";
  for (const character of Array.from(value.normalize("NFC"))) {
    if (measureTextWidth(result + character, fontSize) + suffixWidth > maxWidth) break;
    result += character;
  }
  return result + suffix;
}

export function wrapTextToWidth(value: string, maxWidth: number, fontSize = 13, maxLines?: number): string[] {
  if (!value.trim()) return [];
  if (maxWidth <= 0) return maxLines === undefined ? [value] : [truncateTextToWidth(value, maxWidth, fontSize)];
  const lines: string[] = [];
  let line = "";
  const appendToken = (token: string) => {
    let fragment = "";
    for (const character of Array.from(token)) {
      if (fragment && measureTextWidth(fragment + character, fontSize) > maxWidth) {
        lines.push(fragment);
        fragment = character;
      } else if (!fragment && measureTextWidth(character, fontSize) > maxWidth) {
        lines.push("…");
      } else {
        fragment += character;
      }
    }
    return fragment;
  };
  for (const word of value.normalize("NFC").trim().split(/\s+/u)) {
    const candidate = line ? line + " " + word : word;
    if (measureTextWidth(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    const fragment = appendToken(word);
    if (fragment) {
      if (line && measureTextWidth(line + fragment, fontSize) <= maxWidth) line += fragment;
      else {
        if (line) lines.push(line);
        line = fragment;
      }
    }
  }
  if (line) lines.push(line);
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  const visible = lines.slice(0, Math.max(1, maxLines));
  // Force an ellipsis when vertical capacity hides the remaining lines.
  visible[visible.length - 1] = truncateTextToWidth(visible[visible.length - 1] + "…", maxWidth, fontSize);
  return visible;
}
