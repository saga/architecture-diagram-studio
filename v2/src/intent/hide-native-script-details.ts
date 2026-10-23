/**
 * Hide generated native JavaScript from user-facing chat while preserving the change summary.
 * The original diagnostics remain available in the trace view when troubleshooting is needed.
 */
export function hideNativeScriptDetails(text: string): string {
  const withoutReviewSection = text.replace(
    /\n{0,2}\*{0,2}Exact native script for review:\*{0,2}[\s\S]*$/i,
    ""
  );
  const withoutFencedScripts = withoutReviewSection.replace(
    /\x60{3}(?:javascript|js|typescript|ts)\s*[\s\S]*?\x60{3}/gi,
    ""
  );
  return withoutFencedScripts.replace(/\n{3,}/g, "\n\n").trim();
}
