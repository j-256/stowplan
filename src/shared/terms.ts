export const CURRENT_TERMS_VERSION = "2026-07-29";
export const TERMS_EFFECTIVE_DATE = "July 29, 2026";
export const TERMS_ACCEPTANCE_VALUE = "true";

export const SESSION_PERSISTENCE = Object.freeze({
  BROWSER_SESSION: "browser-session",
  PERSISTENT: "persistent",
});

export type SessionPersistence =
  typeof SESSION_PERSISTENCE[keyof typeof SESSION_PERSISTENCE];

export function isSessionPersistence(
  value: unknown,
): value is SessionPersistence {
  return value === SESSION_PERSISTENCE.BROWSER_SESSION
    || value === SESSION_PERSISTENCE.PERSISTENT;
}
