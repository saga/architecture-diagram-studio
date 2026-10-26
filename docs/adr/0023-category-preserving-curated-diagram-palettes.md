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
5. The role markers, cell colors and active page background change together in one native Draw.io model transaction. Each preset defines a dedicated canvas background color as well as node/category/connector colors; switching presets replaces the active page's previous background. The background is applied through the live graph API and represented in the serialized active page `mxGraphModel background` attribute. Undo/Redo must restore or reapply the background and cell colors together in one step. Other pages and grid settings (`grid`, `gridSize`) remain unchanged; geometry, labels, IDs, parent relationships, endpoints and waypoints are preserved.
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
- Existing hex-colored gradient/label/swimlane/indicator/separator properties follow the assigned theme role; `none`, absent keys, special CSS expressions and image assets are preserved. Each theme applies its own coordinated canvas background to the active page while preserving its grid settings and all other pages.
- Every theme has a distinct full palette signature, with eight distinct categorical fills and strokes.
- Large neutral stencil fixtures recolor internal gray fills across repeated theme switches, while colored stencils and small icons remain byte-for-byte unchanged; the live bridge rejects unsafe stencil mutations.
- More than eight distinct source categories fail before any mutation.
- A planned style change can alter only color properties plus a valid initial `studioColorRole` assignment; an existing role cannot change.
- Applying a theme is one native Undo entry; Undo/Redo restores colors and role markers together.
- Tests cover compressed/uncompressed XML, active-page background changes, unchanged grid settings, saved XML, malformed input, stale revision/page and unchanged non-color properties.
- Undo restores the source background and cell styles together; Redo restores both.
- All ten canvas backgrounds are distinct from each other and their base node fills; background colors are treated as coordinated surface roles, not reused node fills.


## Canvas background design references

The visual identities start from the established theme catalogue in [Anthropic's Theme Factory](https://github.com/anthropics/skills/tree/main/skills/theme-factory). Canvas backgrounds are defined as their own semantic surface role, rather than reusing node fills. This follows [Material 3's color roles](https://docs.flutter.dev/release/breaking-changes/new-color-scheme-roles), which separates surfaces/containers from accent roles, and the deliberate tone families in [Tailwind's color palettes](https://tailwindcss.com/docs/colors). These references guide the method; the exact values below are project-specific and must be reviewed with node fills, connector strokes and text contrast in the actual diagram.

| Theme | Canvas background | Visual relationship |
|---|---|---|
| Ocean Depths | `#C5DDE7` | Muted maritime blue beneath clearer blue/teal nodes |
| Sunset Boulevard | `#F3C9B3` | Warm apricot surface beneath coral/rose categories |
| Forest Canopy | `#C3D8B7` | Sage surface with green, sky and plum distinctions |
| Modern Minimalist | `#D4D8DE` | Neutral-gray canvas with darker strokes and controlled accents |
| Golden Hour | `#EAD18A` | Honey surface with bright gold and complementary cool accents |
| Arctic Frost | `#C1DFEC` | Icy blue surface with teal and indigo accents |
| Desert Rose | `#E3B9C4` | Dusty rose surface with clay, sage and blue categories |
| Tech Innovation | `#C0CDF2` | Periwinkle surface with crisp blue/cyan/violet accents |
| Botanical Garden | `#C7D894` | Leaf-green surface with lighter mint and sky elements |
| Midnight Galaxy | `#10172A` | Deep navy surface with luminous borders and light labels |

The background must remain a native Draw.io page property. Do not simulate it by injecting an opaque CSS layer over the canvas SVG, which can cover the native grid and is not persisted in the document.
