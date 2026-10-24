export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticEntry {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  event: string;
  message: string;
  details: Record<string, unknown>;
}

const STORAGE_KEY = "architecture-diagram-studio:v2:diagnostic-traces";
let activeDiagnosticScope = "single-file";
function currentStorageKey(): string {
  return activeDiagnosticScope === "single-file"
    ? STORAGE_KEY
    : STORAGE_KEY + ":" + encodeURIComponent(activeDiagnosticScope);
}
export function setDiagnosticScope(scope: string): void {
  activeDiagnosticScope = scope.startsWith("workspace:") ? scope : "single-file";
  if (typeof window !== "undefined") window.dispatchEvent(new Event("studio:diagnostic-scope-change"));
}
const MAX_ENTRIES = 1200;
const SENSITIVE_KEY = /^(api.?key|token|secret|password|authorization|prompt|raw.?xml|xml|request.?body|access.?key)$/i;

function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…[truncated]" : value;
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(nested, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function readDiagnosticEntries(): DiagnosticEntry[] {
  try {
    const raw = window.localStorage.getItem(currentStorageKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DiagnosticEntry =>
      !!item && typeof item === "object" &&
      typeof (item as DiagnosticEntry).id === "string" &&
      typeof (item as DiagnosticEntry).timestamp === "string" &&
      typeof (item as DiagnosticEntry).event === "string" &&
      typeof (item as DiagnosticEntry).message === "string"
    ).slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function clearDiagnosticEntries(): void {
  try {
    window.localStorage.setItem(currentStorageKey(), "[]");
  } catch {
    // Keep the UI usable when browser storage is disabled.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("studio:diagnostic-clear"));
}

export function recordDiagnostic(
  event: string,
  message: string,
  details: Record<string, unknown> = {},
  level: DiagnosticLevel = "info"
): DiagnosticEntry {
  const safeDetails = safeValue(details) as Record<string, unknown>;
  const entry: DiagnosticEntry = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    level,
    event,
    message: message.slice(0, 500),
    details: safeDetails
  };

  try {
    const entries = [...readDiagnosticEntries(), entry].slice(-MAX_ENTRIES);
    window.localStorage.setItem(currentStorageKey(), JSON.stringify(entries));
    window.dispatchEvent(new CustomEvent<DiagnosticEntry>("studio:diagnostic", { detail: entry }));
  } catch {
    // Diagnostics must never break diagram editing.
  }

  const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.info;
  consoleMethod("[studio:v2]", entry);

  try {
    void fetch("/api/workspace/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...entry, storageScope: activeDiagnosticScope }),
      keepalive: true
    }).catch(() => {
      // Server logging is best-effort; the operation itself must remain usable.
    });
  } catch {
    // Do not affect the operation being diagnosed.
  }
  return entry;
}
