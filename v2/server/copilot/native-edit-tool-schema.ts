/**
 * JSON Schema for one native Draw.io edit operation.
 *
 * Use anyOf rather than one flat object with optional fields: model providers must be told
 * which fields are required for the selected operation. Each branch has a distinct op enum,
 * making the branches mutually exclusive in practice.
 */
const target = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Exact native cell ID or unique exact visible label."
};

export const NATIVE_EDIT_OPERATION_ITEM_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["select"] },
        target
      },
      required: ["op", "target"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["set_label"] },
        target,
        label: { type: "string", minLength: 1, maxLength: 500, description: "Required replacement label." }
      },
      required: ["op", "target", "label"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["set_style"] },
        target,
        key: { type: "string", enum: ["fillColor", "strokeColor", "fontColor"], default: "fillColor", description: "Optional; defaults to fillColor when omitted." },
        color: { type: "string", minLength: 1, maxLength: 40, description: "Required color value, such as #ff0000 or 红色." }
      },
      required: ["op", "target", "color"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["run_drawio_script"] },
        target: { type: "string", enum: ["active_page"], description: "Execute inside the current native Draw.io editor and page." },
        summary: { type: "string", minLength: 1, maxLength: 1000, description: "Concise user-facing description of the intended diagram change." },
        script: { type: "string", minLength: 1, maxLength: 50000, description: "Synchronous JavaScript body for pinned Draw.io v32.0.2. getDefaultParent/refresh/setCellStyles/insertVertex/insertEdge/removeCells belong to graph; model owns getRoot/getChildCount/getChildAt/getCell/getStyle/setStyle/setValue/setGeometry/setTerminal/beginUpdate/endUpdate. Use listed methods on their declared owner. For unlisted native APIs, first probe typeof owner.method === 'function' on the exact Graph/Model/View object and call only if it exists. Do not author XML, manage pages, use network/storage, or call save/exit actions. Only scripts that pass the server-side insert-only AST checker are automatically dispatched without a separate confirmation click. All other scripts and repaired scripts require review. Keep the script scoped to the user's requested edit; never author replacement XML or invoke save/exit actions." }
      },
      required: ["op", "target", "summary", "script"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["auto_layout"] },
        target: { type: "string", enum: ["active_page"], description: "Always target the active native Draw.io page. Auto layout is a whole-page operation and must be the only item in the batch." },
        engine: { type: "string", enum: ["elk", "dagre"], default: "elk", description: "Studio-owned layout engine. Never call Draw.io's built-in layout action." },
        algorithm: { type: "string", enum: ["layered", "mrtree", "radial", "stress", "force"], default: "layered", description: "ELK algorithm; Dagre uses its directed layered algorithm." },
        direction: { type: "string", enum: ["RIGHT", "LEFT", "DOWN", "UP"], default: "RIGHT", description: "Layout direction." },
        nodeSpacing: { type: "number", minimum: 5, maximum: 500, default: 64, description: "Gap between peer nodes." },
        layerSpacing: { type: "number", minimum: 10, maximum: 800, default: 90, description: "Gap between ranks/layers." },
        edgeRouting: { type: "string", enum: ["ORTHOGONAL", "POLYLINE", "SPLINES"], default: "ORTHOGONAL", description: "ELK connector routing style." },
        iterations: { type: "integer", minimum: 20, maximum: 3000, default: 300, description: "ELK stress/force iteration limit." },
        randomSeed: { type: "integer", minimum: 0, maximum: 100000, default: 1, description: "Reproducible seed for algorithms that use randomness." },
        margin: { type: "number", minimum: 0, maximum: 300, default: 30, description: "Canvas margin after layout normalization." }
      },
      required: ["op", "target"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["move"] },
        target: { ...target, description: "Exact cell ID or unique exact label of a vertex. Moving connector routing is not supported by this operation." },
        dx: { type: "number", minimum: -10000, maximum: 10000, description: "Required horizontal delta." },
        dy: { type: "number", minimum: -10000, maximum: 10000, description: "Required vertical delta." }
      },
      required: ["op", "target", "dx", "dy"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["resize"] },
        target: { ...target, description: "Exact cell ID or unique exact label of a vertex. Resizing connector geometry is not supported by this operation." },
        width: { type: "number", minimum: 1, maximum: 10000, description: "Required width." },
        height: { type: "number", minimum: 1, maximum: 10000, description: "Required height." }
      },
      required: ["op", "target", "width", "height"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["delete"] },
        target
      },
      required: ["op", "target"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add_node_after"] },
        target: { ...target, description: "Required exact cell ID or unique exact visible label of a vertex." },
        newLabel: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "REQUIRED: visible label for the newly created node. Example: newLabel: \"bbb\". Do not omit it or use label instead."
        }
      },
      required: ["op", "target", "newLabel"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add_node_below"] },
        target: { ...target, description: "Required exact cell ID or unique exact visible label of a vertex; the new node is placed directly beneath this vertex." },
        newLabel: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "REQUIRED: visible label for the newly created node. Example: newLabel: \"ddd\"."
        }
      },
      required: ["op", "target", "newLabel"],
      additionalProperties: false
    }
  ]
} as const;
