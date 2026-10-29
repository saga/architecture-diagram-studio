export type StudioConfig = {
  schemaVersion: 1;
  revisionId: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  updatedAt: string;
  updatedBy: string;
};

export function parseConfigHistory(contents: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    if (start < 0) {
      if (ch === "{") { start = i; depth = 1; inString = false; escaped = false; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(contents.slice(start, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
      } catch { /* Ignore malformed historical records and keep any earlier valid snapshots. */ }
      start = -1;
    }
  }
  return records;
}

export function isValidConfigHistoryRecord(record: Record<string, unknown>): boolean {
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) return false;
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length > 100)) return false;
  if (record.reasoningEffort !== undefined && !["low", "medium", "high", "max"].includes(String(record.reasoningEffort))) return false;
  return true;
}
