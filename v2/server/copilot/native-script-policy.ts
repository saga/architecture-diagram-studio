/**
 * Deterministic checks against known shape-discovery anti-patterns.
 * This is defence in depth, not a general JavaScript sandbox.
 */
export function getNativeScriptPolicyViolation(script: string): string | null {
  if (/\bmxStencilRegistry\s*(?:\.\s*getStencil|\[\s*["']getStencil["']\s*\])\s*\(/i.test(script)) {
    return "Do not use mxStencilRegistry.getStencil() as a shape-existence check. Use search_drawio_shapes for vetted local styles; a catalogue miss is inconclusive, and jsShapeClasses inspection only checks mxCellRenderer.defaultShapes.";
  }
  if (/mxgraph\.c4\.|%c4(?:name|type|description)%|\bc4(?:Name|Type|Description)\b/i.test(script)) {
    return "C4 shape/style/metadata edits must use the typed set_c4_type operation. It applies the canonical palette definition and validates shape metadata, dimensions and serialized XML; do not recreate C4 styles in a script.";
  }
  return null;
}
