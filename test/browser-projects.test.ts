import { describe, expect, it } from "vitest";
import config from "../playwright.config";
import {
  BROWSER_PROJECTS,
  BROWSER_SHARDS,
  forProjects,
  projectFilter,
  projectsForShard,
  type BrowserProject,
} from "./e2e/browser-projects";

describe("browser project selection", () => {
  const projects = Object.values(BROWSER_PROJECTS);

  it("includes unrestricted tests in every project", () => {
    for (const project of projects) {
      expect(projectFilter(project).test("app.spec.ts ordinary test @smoke"))
        .toBe(true);
    }
  });

  it("selects exactly the projects tagged on a test", () => {
    const selected: BrowserProject[] = [BROWSER_PROJECTS.phone, BROWSER_PROJECTS.desktop];
    const metadata = forProjects(selected, "Responsive coverage");
    const title = `app.spec.ts responsive test ${metadata.tag.join(" ")}`;
    for (const project of projects) {
      expect(projectFilter(project).test(title)).toBe(selected.includes(project));
    }
    expect(metadata.annotation?.description).toBe("Responsive coverage");
  });

  it("does not match a project name prefix or accept invalid selections", () => {
    expect(projectFilter(BROWSER_PROJECTS.phone)
      .test("test @project:mobile-chromium-extra")).toBe(false);
    expect(() => projectFilter("typo")).toThrow("Unknown browser project");
    expect(() => forProjects([])).toThrow("at least one project");
  });

  it("assigns every configured project to exactly one shard", () => {
    const configured = config.projects!.map(project => project.name).sort();
    expect(BROWSER_SHARDS.flat().sort()).toEqual(configured);
    expect(new Set(BROWSER_SHARDS.flat()).size).toBe(configured.length);
    for (const [index, projects] of BROWSER_SHARDS.entries()) {
      expect(projectsForShard(String(index + 1))).toEqual(projects);
    }
    expect(config.fullyParallel).toBe(false);
  });

  it.each([undefined, "", "0", "-1", "1.5", "01", "1x", "999"])(
    "refuses invalid shard selection %s",
    shard => expect(() => projectsForShard(shard)).toThrow(),
  );
});
