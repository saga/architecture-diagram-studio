/**
 * The multi-file change-set backend is a foundation, not a supported user workflow yet.
 * Keep the write endpoints unavailable until the Copilot proposal/confirmation UI and
 * durable recovery journal are integrated and verified end to end.
 */
export function isWorkspaceChangeSetApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STUDIO_ENABLE_CHANGE_SET_API === "1";
}
