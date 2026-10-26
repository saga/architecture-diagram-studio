# Spatial Region Detection and Layout Plan

Date: 2026-10-26

Status: Phase 1 implemented as a read-only analysis provider. Phase 2 (atomic region projection and region-aware edge routing) is not implemented yet. This document covers region-boundary inference for large rectangular boundaries that have no native Draw.io parent-child relationship.

## 1. Problem and scope

The example [industrial-iot-example.drawio](https://github.com/jgraph/drawio-diagrams/blob/dev/examples/industrial-iot-example.drawio) uses large outline rectangles to communicate ranges such as **IT Network** and **OT Network**. These rectangles and the devices inside them may be ordinary sibling cells in the same layer. They are not equivalent to a native Draw.io Group: there is no XML `parent` relationship that makes the contents move together.

Current auto-layout projection follows native cell ancestry. Switching Dagre, ELK, Graphviz, MSAGL, Cytoscape or D3 alone will not infer the intended containment from geometry. A layout engine must first be given a shared representation of which objects are regions, their members and their boundary crossings.

The authoritative diagram remains native Draw.io XML. Region inference is transient analysis only: do not create a persisted graph model, rewrite cell parents, change styles, or create actual Draw.io Groups as a side effect.

## 2. Industry practice

Mature graph-layout systems generally model containment explicitly rather than assuming every rectangle is a semantic group:

- **Eclipse Layout Kernel (ELK)** uses an inclusion tree for compound graphs. ELK Layered supports compound layout and cross-hierarchy edges when configured. This is the closest match for a future nested-region-aware layout projection. [ELK graph data structure](https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure.html) · [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)
- **Graphviz** supports cluster subgraphs. With `dot` and local cluster ranking, a cluster is laid out separately and integrated into the parent layout as a unit, with a boundary rectangle and optional label. The cluster is represented in the input graph; it is not inferred from an arbitrary rectangle drawn on a canvas. [Graphviz cluster attribute](https://graphviz.org/docs/attrs/cluster/) · [Graphviz clusterrank](https://graphviz.org/docs/attrs/clusterrank/) · [DOT subgraph convention](https://www.graphviz.org/content/dot-language/)
- **Cytoscape.js** compound nodes use an explicit `parent` relationship. Compound-parent dimensions are derived from descendants; it supports semantic graph hierarchy, not automatic recognition of decorative rectangles. [Cytoscape.js compound nodes](https://js.cytoscape.org/#notation/compound-nodes)
- **draw.io** provides explicit constructs such as containers and swimlanes for diagrams whose objects belong to a named region or responsibility. These are preferable when authors can create the structure explicitly; inference is needed for existing diagrams where only a drawn boundary conveys the grouping. [draw.io swimlane diagrams](https://www.drawio.com/docs/diagram-types/swimlane-diagrams/)

**Design implication:** recognize geometry-only regions as a best-effort, confidence-scored analysis. Do not silently equate a visual enclosure with native semantic containment. The user's explicit classification should ultimately take precedence over inference.

## 3. Research and papers

1. Sören Domrös, Reinhard von Hanxleden, Miro Spönemann, Ulf Rüegg and Christoph Daniel Schulze, **“The Eclipse Layout Kernel”** (2023). Explains ELK's compound-graph and explicit-port design, the ELK Layered algorithm, practical integration and lessons from a production-oriented open-source layout library. [arXiv:2311.00533](https://arxiv.org/abs/2311.00533)
2. Hasan Balci and Ugur Dogrusoz, **“fCoSE: A Fast Compound Graph Layout Algorithm with Constraint Support,”** IEEE Transactions on Visualization and Computer Graphics, 28(12), 4582–4593 (2022; first published online 2021). Directly relevant to nested groups and user-specified placement constraints; the implementation is available as a Cytoscape.js extension. [DOI: 10.1109/TVCG.2021.3095303](https://doi.org/10.1109/TVCG.2021.3095303) · [PubMed record](https://pubmed.ncbi.nlm.nih.gov/34232882/)
3. **“A layout algorithm for undirected compound graphs,”** Information Sciences, 179(7), 980–994 (2009). Addresses arbitrary nesting, edges spanning nesting levels and non-uniform node sizes. It is useful background for a later region-aware force-directed alternative, but not a direct solution to detecting rectangles in an existing Draw.io file. [DOI: 10.1016/j.ins.2008.11.017](https://doi.org/10.1016/j.ins.2008.11.017)
4. Kozo Sugiyama and Kazuo Misue, **“Visualization of Structural Information: Automatic Drawing of Compound Digraphs,”** IEEE Transactions on Systems, Man, and Cybernetics, 21(4) (1991). A foundational compound-digraph treatment in which rectangle inclusion represents containment and arrows represent adjacency. [Author-hosted PDF](https://www.cs.tsukuba.ac.jp/~misue/research/topic001-cdag/misue1991c-ieeesmc-visualization.pdf)
5. Chang Han, Justin Lieffers, Clayton Morrison and Katherine E. Isaacs, **“An Overview + Detail Layout for Visualizing Compound Graphs”** (2024). Discusses how a layout can keep higher-level groups legible while revealing nested detail. It supports treating group-level structure as a distinct layout concern rather than flattening everything. [arXiv:2408.04045](https://arxiv.org/abs/2408.04045)
6. Di Bartolomeo et al., **“Evaluating Graph Layout Algorithms: A Systematic Review of Methods and Best Practices,”** Computer Graphics Forum (2024). Useful when defining evaluation criteria and comparing layouts; grouping and compound structures should be evaluated separately from generic node positioning. [DOI: 10.1111/CGF.15073](https://doi.org/10.1111/CGF.15073)

These references provide industry and research precedent for compound layout and constraints. They do **not** establish a reliable universal algorithm for inferring a semantic region from any arbitrary large rectangle. That remains a document-analysis problem requiring conservative heuristics and explicit ambiguity reporting.

## 4. Region recognition model

Each active-page cell is inspected transiently from native XML. Geometry and style are evidence, never a mutation target.

### Candidate evidence

- The cell is a visible, positive-size, top-level vertex in a visible native layer.
- Its shape is rectangular (including an explicit container/swimlane), rather than a device stencil or connector.
- It has no edges directly attached to the boundary cell itself.
- Its area is materially larger than ordinary non-text sibling nodes, and it encloses at least three distinct non-text siblings with a high intersection/containment ratio.
- A native label, explicit container marker or a text cell near the boundary can increase confidence; a label or color alone is not sufficient.
- Candidate regions that overlap without a clear containment relationship are reported as ambiguous rather than assigned an arbitrary nesting order.

Thresholds are implementation heuristics, not Draw.io guarantees. They should be tuned against the supplied Industrial IoT example and regression fixtures rather than treated as universal semantic rules.

### Membership and boundaries

- Full/near-full containment yields a member candidate.
- Text-style cells are reported separately as possible region labels rather than counted as devices.
- A node intersecting a boundary but not mostly inside is reported as a boundary element (for example, a firewall spanning the IT/OT boundary).
- Nested candidate regions are represented separately. Two unrelated overlapping regions, or a node contained in competing overlapping regions, produce ambiguity findings.
- Native Group ancestry remains authoritative and is not replaced by geometry inference.

### Confidence

- **High:** explicit container/swimlane semantics, or strong consistent evidence such as an own label plus several enclosed members.
- **Medium:** a large plain rectangle with multiple enclosed non-text elements but no definitive semantic marker.
- **Low:** conflicting/overlapping candidates or ambiguous membership.

Phase 1 returns diagnostics keyed by native cell IDs. It does not modify XML and does not feed region constraints to the auto-layout engines.

## 5. Layout behavior planned after Phase 1

The initial safe default for a confirmed region is atomic treatment in the outer layout: the region boundary and its members move by the same delta, while member sizes, styles, local/relative positions and internal connector geometry remain unchanged. The outer engine sees a temporary region proxy, not the region's individual children.

Edges crossing the region boundary need a separate routing step. Temporary layout terminals may target the region proxy, but native source/target IDs must remain pointed at the original cells. A node touching multiple regions (such as a boundary firewall) must remain an explicit bridge or a fixed boundary node; it must not be forced into a single region.

A future explicit “layout inside this region” action may rearrange internal nodes while keeping the region's boundary fixed. That is distinct from global layout and must not run implicitly.

Not every region should be freely moved: preserve the existing relative placement of IT and OT regions and boundary infrastructure unless the user explicitly asks to reorganize them. If constraints cannot be honored safely, leave the affected objects untouched and report reduced coverage.

## 6. Implementation phases

### Phase 1 — read-only recognition (current)

- Add a `NativeDiagramAnalysisProvider` implementing the existing capability contract.
- Decode only the active Draw.io page, identify rectangular region candidates, member candidates, boundary elements, probable text labels and conflicting overlaps.
- Surface a diagnostic summary during auto-layout without changing the layout plan or native XML.
- Add unit coverage for explicit containers, ordinary large nodes, region membership, text labels, boundary nodes, overlapping areas, page scoping, invalid requests and stale revisions.

### Phase 2 — atomic region projection

- Extend the shared transient layout projection so every engine sees the same region proxy and constraints.
- Keep geometry of region contents untouched when the outer region moves.
- Preserve native terminal IDs and add boundary waypoints for cross-region edges.
- Maintain revision/page checks, coverage accounting, rollback and native Draw.io serialization.

### Phase 3 — explicit interaction and nested layout

- Allow users to confirm, reject or manually mark inferred regions.
- Offer separate global-layout and region-internal-layout operations.
- Persist explicit user choices only through a documented native Draw.io-safe mechanism; never make the inferred analysis a second source of truth.
- Evaluate all supported layout engines against the same fixtures and compare containment preservation, edge crossings, boundary-edge correctness, overlap, displacement and readability.

## 7. Phase 1 acceptance criteria

- Only the requested page is analyzed; malformed XML, missing pages and stale requests fail closed.
- A plausible large background rectangle with several enclosed nodes is reported by the read-only analyzer; Phase 1 does not yet exclude it from the existing layout projection or change any XML.
- A large normal node connected by edges, a rectangle with too few enclosed nodes and non-rectangular device shapes are not treated as regions.
- Border-crossing nodes and ambiguous overlaps are reported without a forced single-region assignment.
- The provider follows `NativeDiagramAnalysisProvider`: findings only, no operations or replacement XML.
- Existing native layout coordinates/routes and Draw.io apply/save/undo contracts are unchanged.
