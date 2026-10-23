/**
 * True only when the SDK says its persisted session history is absent.
 * Callers may safely start a new SDK session in this case; other resume errors
 * (authentication, quota, transport, etc.) must remain failures.
 */
export function isMissingSdkSessionError(message: string): boolean {
  return /session not found|no such session|unknown session|does not exist|has been deleted/i.test(message);
}
