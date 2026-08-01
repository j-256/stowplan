export const WELCOME_BYPASS_PARAM = "welcome";

// URLSearchParams.has treats a bare ?welcome and ?welcome=1 alike, and does
// not match a longer key such as ?welcomed
export function hasWelcomeBypass(search: string): boolean {
  return new URLSearchParams(search).has(WELCOME_BYPASS_PARAM);
}
