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
// Copilot expects an operation-item schema, not a draft declaration or unrelated root metadata.
export const NATIVE_EDIT_OPERATION_ITEM_SCHEMA = { anyOf: branches };
