import type { PlaywrightTestConfig } from "@playwright/test";
import { describe, expect, it } from "vitest";
import config from "../playwright.config";

const IN_PROCESS_GPU_ARGUMENT = "--in-process-gpu";
type BrowserName = "chromium" | "firefox" | "webkit";
type PlaywrightProject = NonNullable<PlaywrightTestConfig["projects"]>[number];
type ProjectUse = NonNullable<PlaywrightProject["use"]> & {
  defaultBrowserType?: BrowserName;
};

function browserName(project: PlaywrightProject): BrowserName | undefined {
  const use = project.use as ProjectUse | undefined;
  return use?.browserName ?? use?.defaultBrowserType;
}

function launchArguments(project: PlaywrightProject): string[] {
  return project.use?.launchOptions?.args ?? [];
}

describe("Playwright browser process isolation", () => {
  const projects = config.projects ?? [];
  const chromiumProjects = projects.filter(
    project => browserName(project) === "chromium",
  );
  const webkitProjects = projects.filter(
    project => browserName(project) === "webkit",
  );

  it("runs every Chromium project with GPU work in the browser process", () => {
    expect(chromiumProjects.length).toBeGreaterThan(0);
    for (const project of chromiumProjects) {
      expect(launchArguments(project)).toContain(IN_PROCESS_GPU_ARGUMENT);
    }
  });

  it("does not apply the Chromium mitigation to WebKit", () => {
    expect(webkitProjects.length).toBeGreaterThan(0);
    for (const project of webkitProjects) {
      expect(launchArguments(project)).not.toContain(IN_PROCESS_GPU_ARGUMENT);
    }
  });
});
