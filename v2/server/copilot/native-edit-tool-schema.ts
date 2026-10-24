import { z } from "zod";
import { NativeEditOperationSchema } from "../../src/model/native-edit-operations";

/**
 * Generate the Copilot-facing JSON Schema from the runtime contract.
 * Provider-facing guidance lives in Zod descriptions so the two schemas do not drift.
 */
const generatedSchema = z.toJSONSchema(NativeEditOperationSchema, { target: "draft-7", io: "input" }) as {
  $schema?: string;
  anyOf?: unknown[];
  oneOf?: unknown[];
  [key: string]: unknown;
};
const branches = generatedSchema.anyOf ?? generatedSchema.oneOf;
if (!Array.isArray(branches)) {
  throw new Error("Native edit operation schema did not generate a JSON Schema union.");
}
// Keep the provider-facing shape stable: emit enum singletons for op and target literals.
const normalizedBranches = branches.map((raw) => {
  const branch = raw as { properties?: Record<string, unknown> };
  const properties = { ...(branch.properties ?? {}) };
  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === "object" && "const" in value) {
      const literal = (value as { const: unknown }).const;
      const normalized = { ...(value as Record<string, unknown>), enum: [literal] };
      delete normalized.const;
      properties[key] = normalized;
    }
  }
  return { ...branch, properties };
});
// Copilot expects an operation-item schema, not a draft declaration or unrelated root metadata.
export const NATIVE_EDIT_OPERATION_ITEM_SCHEMA = { anyOf: normalizedBranches };
