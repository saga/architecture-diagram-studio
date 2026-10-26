# Spatial Region Detection and Layout Plan

Date: 2026-10-26

Status: Phase 1 and Phase 2 implemented. Geometry-only regions are projected as transient atomic nodes for outer layout; member positions and explicit internal waypoints are translated with the region. Ambiguous, nested and unsupported region candidates remain outside atomic grouping.

## 1. Problem and scope

The example [industrial-iot-example.drawio](https://github.com/jgraph/drawio-diagrams/blob/dev/examples/industrial-iot-example.drawio) uses large outline rectangles to communicate ranges such as **IT Network** and **OT Network**. These rectangles and the devices inside them may be ordinary sibling cells in the same layer. They are not equivalent to a native Draw.io Group: there is no XML `parent` relationship that makes the contents move together.

Native Group layout already follows cell ancestry. Geometry-only region layout now obtains the same outer-layout behavior through one shared transient projection that feeds every supported engine; this projection is derived from the native XML and is never persisted.

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

Phase 1's analysis provider continues to return diagnostics keyed by native cell IDs. Phase 2 consumes the same detection result in the shared layout planner: eligible regions become outer solver vertices, while member cells and probable titles are excluded from the outer solver and receive the region's final translation. XML is still changed only by the existing revision-bound native layout transaction.

## 5. Layout behavior planned after Phase 1

**Implemented in Phase 2:** eligible regions are atomic nodes in the outer layout. The region boundary and its members (including probable boundary title cells) move by the same delta; member sizes, styles, parent IDs and relative positions stay unchanged. The outer engine sees a temporary region proxy, not each individual member.

**Implemented in Phase 2:** cross-boundary edges use temporary region proxy terminals for outer routing. Their native source/target IDs still point to original cells, and boundary waypoints are added at the translated region boundary. Direct internal edges are removed from the outer solver; explicit internal waypoints are translated by the region delta, while waypoint-free internal edges retain native endpoints and let Draw.io recalculate their rendered route. A node touching a region boundary (such as a firewall) remains a standalone bridge node.

A future explicit “layout inside this region” action may rearrange internal nodes while keeping the region's boundary fixed. That is distinct from global layout and must not run implicitly.

Phase 2 makes each region internally atomic, but the selected outer layout engine still decides how separate region proxies are arranged relative to one another. It does not yet guarantee that an existing IT-above-OT order, inter-region spacing, or boundary-node placement is preserved. This is an explicit limitation, not a hidden guarantee; adding user-confirmed spatial-order constraints belongs to the next constraint-aware phase. Ambiguous membership remains excluded from automatic grouping.

## 6. Implementation phases

### Phase 1 — read-only recognition (current)

- Add a `NativeDiagramAnalysisProvider` implementing the existing capability contract.
- Decode only the active Draw.io page, identify rectangular region candidates, member candidates, boundary elements, probable text labels and conflicting overlaps.
- Surface a diagnostic summary during auto-layout without changing the layout plan or native XML.
- Add unit coverage for explicit containers, ordinary large nodes, region membership, text labels, boundary nodes, overlapping areas, page scoping, invalid requests and stale revisions.

### Phase 2 — atomic region projection (implemented)

- Every layout engine receives the same transient region proxy projection; members and probable region titles are not laid out separately.
- Applying a plan moves the border and member vertices by the same delta, retaining size, style, parent IDs and intra-region relative geometry.
- Cross-region edges route through the region boundary while original native source/target IDs are preserved. Internal edges do not enter the outer solver; existing explicit waypoints move with their region.
- Coverage reports regions applied/skipped, member count, boundary nodes and internal connectors.
- Existing revision/page checks, native Draw.io transaction, XML serialization, persistence and version-history contract remain in force.

### Phase 3 — explicit interaction and nested layout

- Allow users to confirm, reject or manually mark inferred regions.
- Offer separate global-layout and region-internal-layout operations.
- Persist explicit user choices only through a documented native Draw.io-safe mechanism; never make the inferred analysis a second source of truth.
- Add optional user-confirmed constraints to preserve relative positions/order between regions and key boundary nodes; Phase 2 does not promise this cross-region spatial relation.
- Evaluate all supported layout engines against the same fixtures and compare containment preservation, edge crossings, boundary-edge correctness, overlap, displacement and readability.

## 7. Phase 1 acceptance criteria

- Only the requested page is analyzed; malformed XML, missing pages and stale requests fail closed.
- A plausible large background rectangle with several enclosed nodes is detected, excluded from independent outer-node layout, and translated atomically with its members by the Phase 2 planner.
- A large normal node connected by edges, a rectangle with too few enclosed nodes and non-rectangular device shapes are not treated as regions.
- Border-crossing nodes and ambiguous overlaps are reported without a forced single-region assignment.
- The provider follows `NativeDiagramAnalysisProvider`: findings only, no operations or replacement XML.
- Existing native layout coordinates/routes and Draw.io apply/save/undo contracts are unchanged.


## 8. Phase 2 acceptance criteria

- For an eligible region, the boundary, enclosed top-level member cells and probable title cells receive exactly the same x/y delta. Width, height, style, labels, native parents and source XML during planning remain unchanged.
- Outer layout engines receive the region cell as one proxy and do not receive member cells as independent vertices or internal edges as outer edges.
- Edges crossing a region retain their original native source/target IDs and get boundary waypoints based on final region/member coordinates.
- Internal region edges are excluded from the outer solver. Existing explicit edge waypoints move by the same region delta; waypoint-free edges rely on native Draw.io rerouting.
- Nested, overlapping, shared-membership and low-confidence candidates are reported as skipped rather than automatically merged.
- The generated plan still uses the shared native XML revision/page/cell-set checks, one native Draw.io model transaction, rollback, serialization acknowledgement and version persistence.
- Unit tests include a controlled geometry fixture and the upstream Industrial IoT example. E2E verifies a real Draw.io transaction moves region and members together and preserves internal waypoints.
