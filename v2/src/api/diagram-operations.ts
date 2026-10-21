import { isDiagramDocument, type DiagramDocument } from "../model/types";

export async function requestServerLayout(document: DiagramDocument): Promise<DiagramDocument> {
  const response = await fetch("/api/workspace/layout", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ document }), signal: AbortSignal.timeout(70_000)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Server-side layout failed (HTTP " + response.status + ")");
  }
  const result = await response.json() as { document: DiagramDocument };
  if (!isDiagramDocument(result.document)) throw new Error("The server returned an invalid diagram document");
  return result.document;
}

/** Server-authoritative layout with the same deterministic local engine as an offline fallback for samples. */
export async function layoutSample(document: DiagramDocument): Promise<DiagramDocument> {
  try {
    return await requestServerLayout(document);
  } catch {
    const { layoutDiagram } = await import("../layout/layout");
    return layoutDiagram(document);
  }
}

export async function requestServerSequenceNormalize(document: DiagramDocument): Promise<DiagramDocument> {
  const response = await fetch("/api/workspace/diagram/normalize-sequence", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document })
  });
  const payload = await response.json() as { document?: DiagramDocument; error?: string };
  if (!response.ok || !payload.document || !isDiagramDocument(payload.document)) {
    throw new Error(payload.error || "Server-side sequence normalisation failed");
  }
  return payload.document;
}
