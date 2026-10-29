/**
 * Native-edit review policy.
 *
 * Studio runs locally for a single operator, so the default is to apply native edits directly.
 * Set STUDIO_REQUIRE_EDIT_CONFIRMATION=1 to require review for whole-page layout and destructive
 * batches. This policy applies to typed native operations; Copilot XML patches are validated and
 * committed through the server-side revision-checked XML workflow.
 */
export const REQUIRE_EDIT_CONFIRMATION_ENV = "STUDIO_REQUIRE_EDIT_CONFIRMATION";

/** True when native edits must be proposed and confirmed instead of applied directly. */
export function requiresNativeEditReview(
  raw: string | undefined = process.env[REQUIRE_EDIT_CONFIRMATION_ENV]
): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (!value) return false;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
