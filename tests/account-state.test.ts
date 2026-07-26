import { describe, expect, it } from "vitest";
import {
  normalizeAuthenticatedAccount,
} from "../src/client/account-state";

describe("authenticated account state", () => {
  it("retains the server identity and administrator role", () => {
    expect(normalizeAuthenticatedAccount({
      displayName: "Bob",
      email: "bob@example.test",
      globalRole: "admin",
      userId: "usr_bob",
    })).toEqual({
      displayName: "Bob",
      email: "bob@example.test",
      globalRole: "admin",
      userId: "usr_bob",
    });
  });

  it("uses safe display and role fallbacks", () => {
    expect(normalizeAuthenticatedAccount({
      email: "bob@example.test",
      globalRole: "owner",
      userId: "usr_bob",
    })).toEqual({
      displayName: "bob@example.test",
      email: "bob@example.test",
      globalRole: "user",
      userId: "usr_bob",
    });
    expect(normalizeAuthenticatedAccount({ globalRole: "admin" })).toBeNull();
  });
});
