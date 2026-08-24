import { describe, expect, it } from "vitest";
import {
  adminRecoveryTokenMatches,
  MAXIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS,
  MINIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS,
} from "../src/server/admin-recovery-token";

describe("admin recovery token", () => {
  const token = "a".repeat(
    MINIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS,
  );

  it("accepts only an exact high-entropy-sized value", async () => {
    await expect(
      adminRecoveryTokenMatches(token, token),
    ).resolves.toBe(true);
    await expect(
      adminRecoveryTokenMatches(token, `${token.slice(0, -1)}b`),
    ).resolves.toBe(false);
  });

  it("fails closed for missing, short, long, or spaced values", async () => {
    await expect(
      adminRecoveryTokenMatches(undefined, undefined),
    ).resolves.toBe(false);
    await expect(
      adminRecoveryTokenMatches("short", "short"),
    ).resolves.toBe(false);
    await expect(
      adminRecoveryTokenMatches(
        "a".repeat(MAXIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS + 1),
        "a".repeat(MAXIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS + 1),
      ),
    ).resolves.toBe(false);
    await expect(
      adminRecoveryTokenMatches(`${token} `, `${token} `),
    ).resolves.toBe(false);
  });

});
