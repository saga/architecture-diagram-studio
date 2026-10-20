# Architecture

## Design principle
Treat the application as an architecture-diagram compiler with a visual editor. The versioned Diagram Document is the source of truth for semantics and logical layout.

## Component flow

```mermaid
flowchart TD
  A[Business context and source evidence] --> B[Context extraction and validation]
  B --> C[Diagram Document / IR]
  C --> D[Diagram-specific layout strategy]
  D --> E[React Flow editor]
  E --> F[Persist semantic edits and geometry]
  F --> G[draw.io XML exporter]
  G --> H[XML validation and visual regression]
  H --> I[Editable draw.io artifact]
```

## Runtime sequence

```mermaid
sequenceDiagram
  actor Architect
  participant UI as React Flow UI
  participant IR as Diagram IR
  participant Layout as Layout Service
  participant Export as draw.io Exporter
  participant Drawio as diagrams.net
  Architect->>UI: Load or create diagram
  UI->>IR: Read semantic model and saved geometry
  Architect->>UI: Request auto-layout
  UI->>Layout: Submit graph and constraints
  Layout-->>UI: Return positions and routes
  Architect->>UI: Manually adjust nodes
  UI->>IR: Persist updated geometry
  Architect->>Export: Export current snapshot
  Export->>Export: Validate IDs and references
  Export-->>Architect: Download draw.io XML
  Architect->>Drawio: Open and inspect
```

## Modules
- Context extraction converts requirements and source material into candidate entities and relations while preserving evidence and uncertainty.
- Diagram IR stores semantics, logical layout, styles, provenance, and schema version.
- Layout strategies use ELK layered layout for C4/dependency views and a dedicated constraint-based layout for sequence diagrams.
- React Flow adapter maps the IR to interactive nodes and edges and writes geometry changes back.
- draw.io exporter maps geometry, styles, containment, ports, and edge waypoints to mxGraph XML.
- Validation checks referential integrity, graph invariants, XML parseability, and visual regressions.

## Geometry fidelity
Use logical canvas coordinates rather than screen pixels multiplied by zoom. Convert React Flow node origins to draw.io top-left geometry. Save measured dimensions and manual edge waypoints. Never rerun layout during export.

Geometry mapping alone cannot guarantee pixel identity: text metrics, font availability, CSS/SVG features, shape primitives, and edge routers differ. Prefer native draw.io cells for editable architecture elements and use embedded SVG selectively.

## Layout policy
- Text or theme changes should not trigger full relayout unless dimensions materially change.
- Structural changes should trigger local layout where possible.
- Full layout is an explicit user action.
- Sequence ordering is a semantic invariant and must not be delegated to a generic graph layout algorithm.