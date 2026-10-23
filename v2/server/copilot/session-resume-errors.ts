/**
 * True only when the SDK says its persisted session history is absent.
 * Callers may safely start a new SDK session in this case; other resume errors
 * (authentication, quota, transport, model/provider configuration, etc.) must remain failures.
 */
export function isMissingSdkSessionError(message: string): boolean {
  if (/session not found|no such session|unknown session/i.test(message)) return true;

  // Do not classify unrelated errors such as "model does not exist" as a missing
  // session: doing so would silently discard recoverable SDK conversation history.
  return /session.{0,100}\b(?:does not exist|has been deleted)\b/i.test(message)
    || /\b(?:does not exist|has been deleted)\b.{0,100}session/i.test(message);
}
