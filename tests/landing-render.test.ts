import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "../app/page";

describe("landing hero", () => {
  const markup = renderToStaticMarkup(createElement(Hero));

  it("shows the eyebrow, name, and subhead", () => {
    expect(markup).toContain("Organize one space at a time");
    expect(markup).toContain("Stowplan");
    expect(markup).toContain(
      "Find what you packed without opening every box.",
    );
  });

  it("shows both primary actions pointing at the demo and the hub", () => {
    expect(markup).toContain("Try the kitchen demo");
    expect(markup).toContain('href="/demo"');
    expect(markup).toContain("Create a workspace");
    expect(markup).toContain('href="/workspaces"');
  });

  it("shows all four value points", () => {
    expect(markup).toContain("Start before the system is perfect");
    expect(markup).toContain("Keep working without service");
    expect(markup).toContain("Find anything quickly");
    expect(markup).toContain("Make fewer physical moves");
  });

  it("links out to the guide, legal policies, and source", () => {
    expect(markup).toContain("User guide");
    expect(markup).toContain("Privacy policy");
    expect(markup).toContain("Terms of Service");
    expect(markup).toContain("Source");
  });
});
