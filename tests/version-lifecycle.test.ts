import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const lifecycleScript = resolve("scripts/preversion.sh");
const projectNpmrc = resolve(".npmrc");
const temporaryRoots: string[] = [];

function run(root: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
}

function requireSuccess(
  result: ReturnType<typeof spawnSync>,
  operation: string,
) {
  if (result.status !== 0) {
    throw new Error(`${operation} failed: ${result.stderr}`);
  }
}

function git(root: string, args: string[]) {
  const result = run(root, "git", args);
  requireSuccess(result, `git ${args.join(" ")}`);
  return result.stdout.trim();
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "stowplan-version-lifecycle-"));
  temporaryRoots.push(root);
  requireSuccess(
    run(root, "git", ["init", "--quiet", "--initial-branch=main"]),
    "git init",
  );
  git(root, ["config", "user.name", "Version Test"]);
  git(root, ["config", "user.email", "version@example.test"]);
  copyFileSync(projectNpmrc, join(root, ".npmrc"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "stowplan-version-lifecycle-test",
      version: "1.0.0",
      private: true,
      scripts: {
        preversion: `bash ${JSON.stringify(lifecycleScript)}`,
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "stowplan-version-lifecycle-test",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "stowplan-version-lifecycle-test",
          version: "1.0.0",
        },
      },
    }, null, 2)}\n`,
  );
  git(root, ["add", ".npmrc", "package.json", "package-lock.json"]);
  git(root, [
    "commit",
    "--quiet",
    "-m",
    "initial",
    "--",
    ".npmrc",
    "package.json",
    "package-lock.json",
  ]);
  return root;
}

function readManifestVersion(root: string) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .version as string;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("npm version lifecycle", () => {
  it("creates npm's default commit and annotated tag on main", () => {
    const root = makeProject();
    const result = run(root, "npm", ["version", "patch"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readManifestVersion(root)).toBe("1.0.1");
    expect(git(root, ["log", "-1", "--format=%s"])).toBe("1.0.1");
    expect(git(root, ["describe", "--tags", "--exact-match", "HEAD"]))
      .toBe("v1.0.1");
    expect(git(root, ["cat-file", "-t", "refs/tags/v1.0.1"]))
      .toBe("tag");
    expect(git(root, [
      "for-each-ref",
      "refs/tags/v1.0.1",
      "--format=%(contents:subject)",
    ])).toBe("1.0.1");
  });

  it("refuses a topic branch without changing the version", () => {
    const root = makeProject();
    git(root, ["switch", "--quiet", "-c", "feature/version"]);
    const result = run(root, "npm", ["version", "patch"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`)
      .toContain("npm version requires branch main; found feature/version");
    expect(readManifestVersion(root)).toBe("1.0.0");
    expect(git(root, ["tag", "--list"])).toBe("");
  });

  it("refuses detached HEAD without changing the version", () => {
    const root = makeProject();
    git(root, ["switch", "--quiet", "--detach"]);
    const result = run(root, "npm", ["version", "patch"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`)
      .toContain("npm version requires branch main; found detached HEAD");
    expect(readManifestVersion(root)).toBe("1.0.0");
    expect(git(root, ["tag", "--list"])).toBe("");
  });
});
