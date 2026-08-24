import { describe, expect, it } from "vitest";
import { hasWelcomeBypass } from "../src/client/landing-bypass";

describe("hasWelcomeBypass", () => {
  it("is true when the welcome flag is present", () => {
    expect(hasWelcomeBypass("?welcome")).toBe(true);
    expect(hasWelcomeBypass("?welcome=1")).toBe(true);
    expect(hasWelcomeBypass("?foo=bar&welcome")).toBe(true);
  });

  it("is false when the welcome flag is absent", () => {
    expect(hasWelcomeBypass("")).toBe(false);
    expect(hasWelcomeBypass("?foo=bar")).toBe(false);
    expect(hasWelcomeBypass("?welcomed=1")).toBe(false);
  });
});
