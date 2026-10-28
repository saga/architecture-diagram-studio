/**
 * Native-edit review policy.
 *
 * Studio runs locally for a single operator, so the default is to apply native edits directly,
 * including `run_drawio_script`: the person asking for the change is the person who would click
 * Confirm, and reviewing every generated script was pure friction.
 *
 * Set STUDIO_REQUIRE_EDIT_CONFIRMATION=1 to restore the review gate for scripts, whole-page
 * layout and destructive batches. That gate is the only place a script is inspected before it
 * runs, so enabling it is a deliberate trade of speed for review.
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
