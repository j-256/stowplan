import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const wrapper = resolve("scripts/with-clean-next-output.sh");
const temporaryRoots: string[] = [];
const staleOutputStatus = 17;
const failedBuildStatus = 23;

function makeProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), "stowplan-next-build-"));
  temporaryRoots.push(projectRoot);
  mkdirSync(join(projectRoot, ".next", "build"), { recursive: true });
  writeFileSync(join(projectRoot, ".next", "build", ".DS_Store"), "stale");
  return projectRoot;
}

function runWrapper(projectRoot: string, childSource: string) {
  return spawnSync(
    "/bin/bash",
    [wrapper, "--", process.execPath, "--input-type=module", "-e", childSource],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, SITES_PROJECT_ROOT: projectRoot },
    },
  );
}

afterEach(() => {
  for (const projectRoot of temporaryRoots.splice(0)) {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("clean Next build output wrapper", () => {
  it("atomically replaces stale output without removing the new build", () => {
    const projectRoot = makeProject();
    const result = runWrapper(projectRoot, `
      import { existsSync, mkdirSync, writeFileSync } from "node:fs";
      if (existsSync(".next")) process.exit(${staleOutputStatus});
      mkdirSync(".next", { recursive: true });
      writeFileSync(".next/result", "fresh");
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(projectRoot, ".next", "result"), "utf8"))
      .toBe("fresh");
    expect(existsSync(join(projectRoot, ".next", "build", ".DS_Store")))
      .toBe(false);
    const quarantineRoot = join(
      projectRoot,
      ".sites-runtime",
      "next-quarantine",
    );
    expect(
      existsSync(quarantineRoot) ? readdirSync(quarantineRoot) : [],
    ).toEqual([]);
  });

  it("preserves a failed build status after removing stale output", () => {
    const projectRoot = makeProject();
    const result = runWrapper(
      projectRoot,
      `process.exit(${failedBuildStatus})`,
    );

    expect(result.status).toBe(failedBuildStatus);
    expect(existsSync(join(projectRoot, ".next"))).toBe(false);
  });
});
