/**
 * Hide generated native JavaScript from user-facing chat while preserving the change summary.
 * The original diagnostics remain available in the trace view when troubleshooting is needed.
 *
 * Two review-section headers exist in the wild: the English one the model is told to emit, and
 * the localized one an earlier proposal message injected by hand. Both must be stripped, and any
 * new header has to be added here as well — a header this function does not recognize leaks the
 * whole script into the transcript.
 */
export function hideNativeScriptDetails(text: string): string {
  const withoutReviewSection = text
    .replace(/\n{0,2}\*{0,2}Exact native script for review:\*{0,2}[\s\S]*$/i, "")
    .replace(/\n{0,2}\*{0,2}原生 Draw\.io 脚本（完整内容）[：:]\*{0,2}[\s\S]*$/i, "");
  const withoutFencedScripts = withoutReviewSection.replace(
    /\x60{3}(?:javascript|js|typescript|ts)\s*[\s\S]*?\x60{3}/gi,
    ""
  );
  return withoutFencedScripts.replace(/\n{3,}/g, "\n\n").trim();
}
