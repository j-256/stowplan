import type { RuntimeEnv } from "../../src/server/runtime";

export const TEST_IDENTITY_DIGEST_KEY =
  "test-identity-digest-key-at-least-32-bytes";

export const TEST_AUTH_ENV = Object.freeze({
  AUTH_IDENTITY_DIGEST_KEY: TEST_IDENTITY_DIGEST_KEY,
}) satisfies RuntimeEnv;
