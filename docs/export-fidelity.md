# draw.io Export Fidelity and Verification Plan

## What is preserved today

| Property | Current behavior | Verification |
|---|---|---|
| Node position | React Flow logical coordinates are exported as mxGraph geometry | Unit test checks non-integer coordinates |
| Node dimensions | Measured dimensions are used when available; style/default dimensions are fallback | Unit test checks dimensions |
| Node labels | Labels and technology are XML-escaped and exported as explicit HTML title/subtitle blocks, avoiding XML-attribute newline normalization | Unit test checks escaping and title/subtitle styling |
| Relationships | Source/target references and labels are exported as native edges | Model validation rejects missing endpoints |
| Edge waypoints | Shared routing creates deterministic orthogonal routes when no layout engine provides points; ELK bend points are retained and mapped to mxGraph points arrays | Unit tests check route geometry and exported points |
| Export side effects | Export does not call layout or mutate the document | Export function is pure |
| Repeatability | Generated modification timestamp is omitted | Unit test checks byte-for-byte stability |

## Important limitation

Equal coordinates alone do not imply pixel-identical rendering. The adapter now aligns major causes of drift: React Flow's person and database renderers imitate the native draw.io UML actor and cylinder, title/technology are split using the same font hierarchy, endpoint ports are stored in the Diagram Document, and both renderers use the same orthogonal bend points. draw.io export uses `edgeStyle=none` for explicit routes rather than asking mxGraph to independently re-route them. Remaining differences can still come from font metrics, SVG/shape primitives, zoom, and application-specific label placement; a rendered integration test is required before making a pixel-identity claim.

For a requirement that is genuinely pixel-level, first define which output is authoritative:

1. **Editable diagram:** native draw.io shapes and edges; accept renderer-specific visual differences.
2. **Exact visual appearance:** embed a generated SVG as a background/image; this sacrifices native editability of the depicted elements.
3. **Hybrid:** native cells for normal editing plus an optional SVG reference/render for visual comparison.


## Shared rendering contract

| Visual element | React Flow | draw.io | Shared source |
|---|---|---|---|
| Node extent | Logical x/y/width/height | mxGraph vertex geometry | `DiagramDocument.layout` |
| Person | SVG actor icon + label below its bounds | Native `umlActor` shape | Node type, label, geometry, stroke/fill tokens |
| Database | SVG cylinder outline and top ellipse | Native `cylinder3` shape | Node type, label, geometry, stroke/fill tokens |
| Technology subtitle | 10 px muted second row | Explicit HTML subtitle row | `DiagramNode.label` + `technology` |
| Edge endpoints | Named React Flow handles | `exitX` / `exitY` / `entryX` / `entryY` | `sourceHandleId`, `targetHandleId`, node port geometry |
| Edge path | Custom SVG polyline through stored waypoints | `mxPoint` array with `edgeStyle=none` | `DiagramRelation.waypoints` |
| Edge label | HTML overlay at path midpoint | Native mxGraph edge label | Relation label and shared logical path |

Legacy version-1 documents with no port fields/routes are normalized in a temporary copy. This does not move nodes, mutate persisted state, or invoke an auto-layout algorithm. Manual node movement invalidates connected routes so they are recalculated from the current handle positions.

## Next verification stages

1. Run `npm install`, `npm run typecheck`, `npm test`, and `npm run build` in CI.
2. Add representative fixtures for long labels, Unicode, external systems, database shapes, self-relations, multiple edges, and waypoint routing.
3. Open exported files in diagrams.net and verify that node geometry and edge endpoints are correct.
4. Automate a browser round-trip: load fixture, export, import/render in diagrams.net, take a screenshot, and compare with a documented tolerance.
5. Record intentional differences separately from regressions; avoid a single global pixel threshold for text-heavy diagrams.
6. Test manual layout after reload and ensure export is independent of zoom and viewport position.

## Coordinate contract

- Geometry uses logical canvas coordinates, not CSS screen pixels.
- Node x/y represent top-left coordinates in both React Flow's default node origin and mxGraph geometry.
- Zoom and pan must not affect exported positions.
- A future custom node origin must be converted to top-left coordinates before export.
- Waypoints are logical canvas coordinates and must not be reconstructed from the rendered edge path during export.
