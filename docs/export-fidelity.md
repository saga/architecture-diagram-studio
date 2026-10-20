# draw.io Export Fidelity and Verification Plan

## What is preserved today

| Property | Current behavior | Verification |
|---|---|---|
| Node position | React Flow logical coordinates are exported as mxGraph geometry | Unit test checks non-integer coordinates |
| Node dimensions | Measured dimensions are used when available; style/default dimensions are fallback | Unit test checks dimensions |
| Node labels | Labels and technology are XML-escaped and exported in native cells | Unit test checks escaping |
| Relationships | Source/target references and labels are exported as native edges | Model validation rejects missing endpoints |
| Edge waypoints | Optional model waypoints map to mxGraph points arrays | Unit test checks exported points |
| Export side effects | Export does not call layout or mutate the document | Export function is pure |
| Repeatability | Generated modification timestamp is omitted | Unit test checks byte-for-byte stability |

## Important limitation

Equal coordinates do not imply pixel-identical rendering. React Flow and diagrams.net can use different fonts, line wrapping, shape primitives, stroke placement, label offsets, and edge routers. The current exporter aims to preserve editable geometry and semantics, not screenshot identity.

For a requirement that is genuinely pixel-level, first define which output is authoritative:

1. **Editable diagram:** native draw.io shapes and edges; accept renderer-specific visual differences.
2. **Exact visual appearance:** embed a generated SVG as a background/image; this sacrifices native editability of the depicted elements.
3. **Hybrid:** native cells for normal editing plus an optional SVG reference/render for visual comparison.

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
