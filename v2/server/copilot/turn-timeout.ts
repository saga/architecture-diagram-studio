/** A single wall-clock budget for one Copilot turn, including the fallback terminal-tool retry. */
export const DEFAULT_COPILOT_TURN_TIMEOUT_MS = 5 * 60_000;
export const MIN_COPILOT_TURN_TIMEOUT_MS = 10_000;
export const MAX_COPILOT_TURN_TIMEOUT_MS = 15 * 60_000;

export const DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS = 90_000;
export const MIN_COPILOT_TURN_IDLE_TIMEOUT_MS = 10_000;
export const MAX_COPILOT_TURN_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Read STUDIO_COPILOT_TURN_TIMEOUT_MS from the local server environment.
 * Invalid/missing values use the five-minute default; valid values are clamped to 10 seconds–15 minutes.
 */
export function resolveCopilotTurnTimeoutMs(
  raw: string | undefined = process.env.STUDIO_COPILOT_TURN_TIMEOUT_MS
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_COPILOT_TURN_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_COPILOT_TURN_TIMEOUT_MS;
  return Math.min(MAX_COPILOT_TURN_TIMEOUT_MS, Math.max(MIN_COPILOT_TURN_TIMEOUT_MS, parsed));
}

/**
 * Read STUDIO_COPILOT_TURN_IDLE_TIMEOUT_MS from the local server environment.
 * This is the maximum quiet period without meaningful SDK progress; the total turn deadline still applies.
 */
export function resolveCopilotTurnIdleTimeoutMs(
  raw: string | undefined = process.env.STUDIO_COPILOT_TURN_IDLE_TIMEOUT_MS
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS;
  return Math.min(MAX_COPILOT_TURN_IDLE_TIMEOUT_MS, Math.max(MIN_COPILOT_TURN_IDLE_TIMEOUT_MS, parsed));
}
