# ADR-0009: Centralized Draw.io XML Processing

- Status: Partially superseded by ADR-0011; shared parsing, validation and security principles remain applicable
- Date: 2026-10-22
- Related: [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md), [ADR-0007 — Unified Theme Adapter for Native Draw.io](./0007-unified-theme-adapter-for-native-drawio.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md)

## Compatibility with ADR-0011

ADR-0011 supersedes this ADR wherever it calls for `DiagramDocument` projection, a source-preserving mutation/patcher API in `drawio-xml-source.ts`, or semantic-model round trips. Current V2 uses the shared parser and schema for native XML inspection and validation, while mutations are executed through Draw.io's native graph/editor bridge. Do not recreate the removed importer/exporter or a parallel source-patching subsystem merely to satisfy the historical implementation notes below.

## Context

Draw.io XML was handled through several independent mechanisms: DOM parsing in import and theme code, a separate DOM parser in the Zod schema validator, local XML attribute escaping helpers, and string-based XML construction in export. The source-preserving patcher also scans raw XML to retain exact source slices. Multiple parsing and escaping implementations risk inconsistent validation, unsafe assumptions about malformed input, and regressions when one path changes without the others.

ADR-0006 establishes the complete native Draw.io XML document as the only authoritative document source. XML processing must follow that decision: semantic models may be derived projections, not alternate persistent sources.

## Decision

**Use one shared XML adapter for parsing, serialization, and attribute escaping; retain raw-source scanning only where it is required to preserve untouched XML.**

The shared adapter is `v2/src/model/drawio-xml-dom.ts` and exposes:

- `parseDrawioXml`: the common `@xmldom/xmldom` parser boundary, with parser-error handling and rejection of DTD/custom entity declarations by default.
- `serializeDrawioXml`: the common serializer for DOM-backed XML documents and nodes.
- `encodeDrawioXmlAttribute`: the single XML attribute escaping implementation.
- `findDrawioElements`: a small shared DOM lookup helper.

The following rules apply to all XML processing paths:

1. **Parsing:** import, schema validation, theme utilities, and future XML consumers must use `parseDrawioXml`; do not instantiate `DOMParser` independently outside the shared adapter without documenting and approving a specific exception.
2. **Serialization:** any DOM mutation that needs serialization must use `serializeDrawioXml`; do not introduce local `XMLSerializer` instances.
3. **Escaping:** XML attribute values must use DOM attribute APIs or `encodeDrawioXmlAttribute`. Do not add independent escaping implementations. Text and HTML label content must be escaped according to their own output context; XML escaping must not be mistaken for HTML sanitization.
4. **Validation:** `drawio-xml-schema.ts` remains the shared Zod structural-validation layer. It consumes the common parser and applies Draw.io-specific root, page, cell, geometry and payload rules. The DOM adapter does not replace Zod validation.
5. **Authoritative source:** the complete original `mxfile` XML remains the source of truth. A derived `DiagramDocument` must not be serialized back as a replacement for an existing native document.
6. **Lossless patching:** `drawio-xml-source.ts` may retain a bounded lexical scanner for locating exact raw XML slices and preserving untouched bytes. This is a deliberate source-preservation mechanism, not a second general-purpose XML parser. Before patching, the document must pass shared structural validation. If the scanner cannot safely establish the target boundaries, the edit must fail closed rather than regenerate the whole document.
7. **No-op preservation:** read-only processing and no-op edits must return the original XML string when possible. Do not serialize a DOM merely for inspection, because attribute ordering, whitespace, declarations or formatting may change.
8. **Compressed pages:** Base64/DEFLATE decoding is payload processing, not XML parsing. After decoding, the resulting XML must enter the same shared parser and schema-validation path. Keep decompression limits and format-specific error handling.
9. **Security:** DTD and custom entity declarations are rejected by default. Do not enable them for convenience. Treat XML and embedded HTML labels as untrusted input, and keep XML parsing separate from HTML rendering/sanitization.
10. **Scope:** XML-like regexes used only to interpret HTML labels, normalize Base64 payload whitespace, or identify raw byte ranges are not automatically replacements for the XML parser. Any regex that interprets XML structure or mutates XML attributes must be reviewed against this ADR.

## Consequences

- Parsing errors and XML escaping behavior have one shared implementation.
- Zod remains responsible for the Draw.io-specific extensible schema contract; the adapter remains responsible for well-formed XML parsing and serialization.
- Source-preserving edits can avoid reformatting the entire file, retaining unknown attributes, custom elements, pages and metadata.
- New XML code has a clear entry point and can be covered by focused adapter tests.
- Full-file serialization is permitted for newly generated XML or deliberate DOM mutations, but not as a fallback that discards an existing authoritative source.

## Rejected alternatives

### Use `fast-xml-parser` and its builder as a second representation

Rejected for the current implementation. The project already depends on `@xmldom/xmldom`, which provides DOM APIs needed for nested Draw.io structures and selective mutations. Adding a second parser/builder would increase conversion and fidelity risks without removing the need for raw-source preservation.

### Replace every raw-source operation with whole-document DOM serialization

Rejected because serialization can alter formatting and lexical representation even when the semantic XML is unchanged. Exact-source preservation is a requirement for safe patches to existing documents.

### Treat the Zod schema as the XML parser

Rejected because Zod validates the normalized structural view, not XML syntax or serialization. The parser and schema have distinct responsibilities and must share the same parse boundary.

## Implementation status

The shared adapter has been introduced and adopted by schema validation, import, theme utilities, attribute escaping and generated XML export. Adapter tests cover parsing, serialization, DTD rejection, safe comments/CDATA and attribute escaping.

The raw-source patcher intentionally retains its bounded scanner to preserve original XML slices. A repository-wide audit remains necessary whenever new XML processing is added; this ADR does not claim that every XML-related regular expression has been eliminated or that all existing paths have been proven lossless by runtime tests.

## Verification criteria

- No direct `DOMParser` or `XMLSerializer` usage exists outside the shared adapter, except a documented and reviewed exception.
- Import, validation, theme utilities and export use the shared adapter.
- XML attribute escaping is not duplicated.
- Existing multi-page documents, compressed pages, unknown elements, custom attributes and untouched cell text survive no-op and supported edit round trips.
- Malformed XML and DTD/custom entity declarations fail safely.
- An unsafe source patch is rejected rather than replaced by XML reconstructed from a partial semantic projection.
- Unit tests and build checks pass; CI status is reported separately and is not inferred from a commit being created.
