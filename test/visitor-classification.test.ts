import { describe, expect, it } from "vitest";
import {
  classifyVisitor,
  VISITOR_KIND,
} from "../src/client/visitor-classification";

describe("classifyVisitor", () => {
  it("treats a bypass as a newcomer regardless of other signals", () => {
    expect(
      classifyVisitor({
        hasLocalWorkspaces: true,
        hasRememberedAccount: true,
        bypass: true,
      }),
    ).toBe(VISITOR_KIND.NEWCOMER);
  });

  it("is known when local workspaces exist", () => {
    expect(
      classifyVisitor({
        hasLocalWorkspaces: true,
        hasRememberedAccount: false,
        bypass: false,
      }),
    ).toBe(VISITOR_KIND.KNOWN);
  });

  it("is known when an account is remembered", () => {
    expect(
      classifyVisitor({
        hasLocalWorkspaces: false,
        hasRememberedAccount: true,
        bypass: false,
      }),
    ).toBe(VISITOR_KIND.KNOWN);
  });

  it("is a newcomer when nothing is known and there is no bypass", () => {
    expect(
      classifyVisitor({
        hasLocalWorkspaces: false,
        hasRememberedAccount: false,
        bypass: false,
      }),
    ).toBe(VISITOR_KIND.NEWCOMER);
  });
});
