# ADR-0023: Category-Preserving Curated Diagram Palettes

- Status: Accepted
- Date: 2026-10-26
- Supersedes: the uniform-recoloring behavior in [ADR-0020 — Native Draw.io Diagram Theme Presets](./0020-native-drawio-diagram-theme-presets.md)
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)

## Context

The first implementation of diagram color presets applied one fill/stroke/font triple to every ordinary vertex. That made the preset visually coherent but erased distinctions already encoded in the source diagram: green, blue, orange and yellow categories all became the same color. A theme must change the palette without destroying the diagram author's category structure.

Palette selection must also be deterministic. Color roles should not be synthesized randomly at runtime, and theme switching must not reinterpret the newly applied colors as if they were the original source palette. Native Draw.io XML remains the only persisted diagram model; there is no sidecar graph model.

## Decision

1. Keep the Diagram colors selector as a document operation, independent of Studio's application appearance. It continues to apply through a revision/page-bound native Draw.io model transaction and the normal save/version path.
2. Ship ten named, fixed palettes: Ocean Depths, Sunset Boulevard, Forest Canopy, Modern Minimalist, Golden Hour, Arctic Frost, Desert Rose, Tech Innovation, Botanical Garden and Midnight Galaxy. Each palette defines a neutral base, text/connector colors and eight curated categorical fill/stroke pairs. There is no runtime random color generation.
3. Use original native styles to establish the category map on first application, per page:
   - A visible, non-text vertex is categorized by its explicit fill color when present; an outline-only vertex falls back to its stroke color.
   - A connector is categorized by its stroke color.
   - Cells with the same source color key share one category. New categories receive stable role numbers in first-seen XML order.
   - Unstyled/default cells use the base role. Text-only cells use the text role and remain unfilled.
4. Store the role as the small custom style key `studioColorRole` on each colorable mxCell: `base`, `text` or `category-1` through `category-8`. This marker is part of the native style string, not a second graph model. The selected theme maps each role to its own pre-defined colors. Repeated theme switches therefore use the stored role, not the last theme's fill color, as category identity.
5. The marker and colors are changed together in one Draw.io model transaction. Existing roles cannot be silently reassigned by a theme change; native Undo/Redo restores both the prior colors and role markers together. Unknown non-color style keys, geometry, labels, IDs, parent relationships, endpoints, waypoints, page background and grid remain unchanged. In addition to the primary fill/stroke/font properties, an existing hex-colored gradient, label background/border, swimlane fill, indicator, separator or secondary-font color follows the same assigned role. Absent properties are not introduced; explicit `none` and non-hex CSS expressions are preserved. Embedded image/SVG resources are not rewritten because they may contain brand artwork. Large neutral monochrome Draw.io stencil backplates may recolor only their grayscale midtone `<fillcolor>` values; stencil paths, dimensions, strokes, white/transparent fills and chromatic stencils remain unchanged. The native bridge independently verifies that only those fill-color values changed.
6. If a page contains more than eight distinct original color categories, fail closed and explain the limit. Never collapse excess categories onto a repeated color just to complete the operation. The eight curated roles can be expanded deliberately in a later palette revision.
7. A source document that was already uniformly recolored by the older implementation has lost the original category information in its current XML. Do not guess the lost colors. Restore the original file/version where possible before applying the new behavior.
8. Color associations are treated as design context, not universal psychological rules. Palette character comes from the combined hue, lightness, chroma, neutral balance, and contrast. Themes must be visually distinguishable in the actual diagram, not just in the selector: curated base fills and categorical fills need visible hue/value separation, with strong outlines and readable text. Midnight Galaxy uses dark fills and luminous outlines/light text. Each preset is static and reviewed in source control.

## Curated theme intent

| Theme | Intended character |
|---|---|
| Ocean Depths | Calm, professional blues/teals with restrained warm accents |
| Sunset Boulevard | Warm coral, apricot and gold, balanced with cool accents |
| Forest Canopy | Grounded greens and earth tones, with blue/purple distinctions |
| Modern Minimalist | Neutral grays with a small set of controlled categorical accents |
| Golden Hour | Muted honey, ochre, clay and complementary cool tones |
| Arctic Frost | Cool blues, teals and lavenders with limited warm contrast |
| Desert Rose | Muted rose, clay, sand and sage |
| Tech Innovation | Crisp blue/cyan with violet, green, pink and amber category accents |
| Botanical Garden | Leaf, sage and mint colors balanced with soil and sky tones |
| Midnight Galaxy | Dark navy-based surfaces, differentiated luminous outlines and light text |

The palettes take inspiration from the curated-theme workflow in [Anthropic's theme-factory](https://github.com/anthropics/skills/tree/main/skills/theme-factory), hand-picked palette collections in [Color Hunt](https://colorhunt.co/), and the perceptual/accessibility guidance in [meodai/skill.color-expert](https://github.com/meodai/skill.color-expert). These are design references, not runtime dependencies. The actual hex values are declared and versioned in `v2/src/model/drawio-theme.ts`.

## Validation

- A fixture with four distinct source colors remains four distinct categorical roles across all ten themes.
- Repeated switching preserves role IDs; cells sharing a source color continue to share a role.
- Base/default cells, text-only vertices, filled vertices, outline-only shapes and color-coded connectors are covered.
- Existing hex-colored gradient/label/swimlane/indicator/separator properties follow the assigned theme role; `none`, absent keys, special CSS expressions, image assets, page background and grid are preserved.
- Every theme has a distinct full palette signature, with eight distinct categorical fills and strokes.
- Large neutral stencil fixtures recolor internal gray fills across repeated theme switches, while colored stencils and small icons remain byte-for-byte unchanged; the live bridge rejects unsafe stencil mutations.
- More than eight distinct source categories fail before any mutation.
- A planned style change can alter only color properties plus a valid initial `studioColorRole` assignment; an existing role cannot change.
- Applying a theme is one native Undo entry; Undo/Redo restores colors and role markers together.
- Tests cover compressed/uncompressed XML, background/grid preservation, saved XML, malformed input, stale revision/page and unchanged non-color properties.
