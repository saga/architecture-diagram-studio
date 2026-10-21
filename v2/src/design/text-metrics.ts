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
