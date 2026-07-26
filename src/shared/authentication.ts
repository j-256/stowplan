export const OAUTH_TURNSTILE_ACTION = "oauth_start";

export const SESSION_AUTHENTICATION_PROVIDER = Object.freeze({
  ACCESS_MIGRATION: "cloudflare-access",
  DEVELOPMENT: "development",
  GOOGLE: "google",
} as const);

export type SessionAuthenticationProvider =
  typeof SESSION_AUTHENTICATION_PROVIDER[
    keyof typeof SESSION_AUTHENTICATION_PROVIDER
  ];

export const SESSION_REVOCATION_SCOPE = Object.freeze({
  PRE_GOOGLE: "pre-google",
} as const);
