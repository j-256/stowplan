import { defineConfig } from "@playwright/test";
import config, { PLAYWRIGHT_WORKER_LIMITS } from "./playwright.config";
import { projectsForShard } from "./test/e2e/browser-projects";

const selectedProjects = new Set<string>(
  projectsForShard(process.env.STOWPLAN_BROWSER_SHARD),
);

export default defineConfig({
  ...config,
  workers: PLAYWRIGHT_WORKER_LIMITS.ci,
  reporter: [
    ["github"],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  projects: config.projects?.filter(project =>
    selectedProjects.has(project.name ?? "")
  ),
});
