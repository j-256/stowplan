import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlaywrightTestConfig } from "@playwright/test";
import { describe, expect, it } from "vitest";
import config from "../playwright.config";

const FULL_CHROMIUM_CHANNEL = "chromium";
const IN_PROCESS_GPU_ARGUMENT = "--in-process-gpu";
const PLAYWRIGHT_INSTALL_COMMAND =
  "npx playwright install --with-deps --no-shell chromium webkit";
const PLAYWRIGHT_TRACE_ARTIFACT_PATH =
  "path: test-results/**/trace.zip";
const projectRoot = process.cwd();
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

  it("runs every Chromium project with the full Chromium browser", () => {
    expect(chromiumProjects.length).toBeGreaterThan(0);
    for (const project of chromiumProjects) {
      expect(project.use?.channel).toBe(FULL_CHROMIUM_CHANNEL);
      expect(launchArguments(project)).not.toContain(
        IN_PROCESS_GPU_ARGUMENT,
      );
    }
  });

  it("leaves WebKit on its standard browser channel", () => {
    expect(webkitProjects.length).toBeGreaterThan(0);
    for (const project of webkitProjects) {
      expect(project.use?.channel).toBeUndefined();
      expect(launchArguments(project)).not.toContain(IN_PROCESS_GPU_ARGUMENT);
    }
  });

  it("does not install the unused Chromium headless shell in workflows", () => {
    for (const workflow of ["ci.yml", "release.yml"]) {
      const contents = readFileSync(
        join(projectRoot, ".github", "workflows", workflow),
        "utf8",
      );
      expect(contents).toContain(PLAYWRIGHT_INSTALL_COMMAND);
    }
  });

  it("retains Playwright traces from release verification", () => {
    const releaseWorkflow = readFileSync(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(releaseWorkflow).toContain(PLAYWRIGHT_TRACE_ARTIFACT_PATH);
  });
});
