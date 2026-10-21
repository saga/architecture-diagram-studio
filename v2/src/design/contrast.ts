export interface ContrastPair {
  foreground: string;
  background: string;
  minimum: number;
  label: string;
}

function rgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) return null;
  const expanded = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255
  ];
}

function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number | null {
  const channels = rgb(hex);
  if (!channels) return null;
  const [r, g, b] = channels.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  if (fg === null || bg === null) return 1;
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function auditContrast(pairs: ContrastPair[]): Array<ContrastPair & { ratio: number }> {
  return pairs.flatMap((pair) => {
    const ratio = contrastRatio(pair.foreground, pair.background);
    return ratio + 0.001 < pair.minimum ? [{ ...pair, ratio }] : [];
  });
}
