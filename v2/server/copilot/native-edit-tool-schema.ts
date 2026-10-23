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
        script: { type: "string", minLength: 1, maxLength: 50000, description: "Synchronous JavaScript body for pinned Draw.io v32.0.2. getDefaultParent/refresh/setCellStyles/insertVertex/insertEdge/removeCells belong to graph; model owns getRoot/getChildCount/getChildAt/getCell/getStyle/setStyle/setValue/setGeometry/setTerminal/beginUpdate/endUpdate. Use listed methods on their declared owner. For unlisted native APIs, first probe typeof owner.method === 'function' on the exact Graph/Model/View object and call only if it exists. Do not author XML, manage pages, use network/storage, or call save/exit actions. Scripts always require explicit user confirmation." }
      },
      required: ["op", "target", "summary", "script"],
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
    }
  ]
} as const;
