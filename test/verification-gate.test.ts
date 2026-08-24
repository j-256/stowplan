import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const temporaryRoots: string[] = [];
const copiedFiles = [
  ".codex/hooks/verification_gate.py",
  ".githooks/pre-push",
  "scripts/install-git-hooks.sh",
  "scripts/restore-next-generated-agents.sh",
  "scripts/verification-state.py",
  "scripts/verify-ready.sh",
];

function run(
  root: string,
  command: string,
  arguments_: string[],
  options: {
    env?: Record<string, string | undefined>;
    input?: string;
  } = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
  });
}

function requireSuccess(
  result: SpawnSyncReturns<string>,
  operation: string,
) {
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
}

function git(root: string, arguments_: string[]) {
  const result = run(root, "git", arguments_);
  requireSuccess(result, `git ${arguments_.join(" ")}`);
  return result.stdout.trim();
}

function copyTrackedFile(root: string, relativePath: string) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(repositoryRoot, relativePath), destination);
}

function makeProject(options: { readyScripts?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stowplan-verification-gate-"));
  temporaryRoots.push(root);
  requireSuccess(
    run(root, "git", ["init", "--quiet", "--initial-branch=main"]),
    "git init",
  );
  git(root, ["config", "user.name", "Verification Test"]);
  git(root, ["config", "user.email", "verification@example.test"]);
  for (const relativePath of copiedFiles) {
    copyTrackedFile(root, relativePath);
  }
  writeFileSync(join(root, "fixture.txt"), "initial\n");
  if (options.readyScripts) {
    writeFileSync(
      join(root, "scripts/verify.sh"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '[[ "${FAIL_CORE:-0}" != "1" ]]',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "scripts/verify-browser.sh"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '[[ "${FAIL_BROWSER:-0}" != "1" ]]',
        "",
      ].join("\n"),
    );
  }
  const trackedFiles = ["fixture.txt", ...copiedFiles];
  if (options.readyScripts) {
    trackedFiles.push("scripts/verify.sh", "scripts/verify-browser.sh");
  }
  git(root, ["add", ...trackedFiles]);
  git(root, ["commit", "--quiet", "-m", "initial", "--", ...trackedFiles]);
  return root;
}

function state(root: string, arguments_: string[]) {
  return run(root, "python3", ["scripts/verification-state.py", ...arguments_]);
}

function record(root: string) {
  const result = state(root, ["record", "HEAD"]);
  requireSuccess(result, "record verification");
}

function hook(
  root: string,
  payload: Record<string, unknown>,
) {
  return run(
    root,
    "python3",
    [".codex/hooks/verification_gate.py"],
    { input: JSON.stringify(payload) },
  );
}

function hookOutput(result: SpawnSyncReturns<string>) {
  requireSuccess(result, "verification hook");
  return result.stdout.trim()
    ? JSON.parse(result.stdout) as Record<string, unknown>
    : null;
}

function prePushInput(root: string, localOid?: string) {
  const oid = localOid ?? git(root, ["rev-parse", "HEAD"]);
  return `refs/heads/main ${oid} refs/heads/main ${"0".repeat(40)}\n`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("exact commit verification state", () => {
  it("ties a clean-worktree proof to one commit", () => {
    const root = makeProject();
    expect(state(root, ["check", "--quiet", "HEAD"]).status).not.toBe(0);

    record(root);
    expect(state(root, ["check", "--quiet", "HEAD"]).status).toBe(0);

    writeFileSync(join(root, "fixture.txt"), "dirty\n");
    expect(state(root, [
      "check",
      "--quiet",
      "--require-clean",
      "HEAD",
    ]).status).not.toBe(0);

    git(root, ["add", "fixture.txt"]);
    git(root, [
      "commit",
      "--quiet",
      "-m",
      "change",
      "--",
      "fixture.txt",
    ]);
    expect(state(root, ["check", "--quiet", "HEAD"]).status).not.toBe(0);
  });

  it("clears an earlier proof when a ready verification rerun fails", () => {
    const root = makeProject({ readyScripts: true });
    const first = run(root, "bash", ["scripts/verify-ready.sh"]);
    requireSuccess(first, "ready verification");
    expect(state(root, ["check", "--quiet", "HEAD"]).status).toBe(0);

    const failed = run(root, "bash", ["scripts/verify-ready.sh"], {
      env: { FAIL_BROWSER: "1" },
    });
    expect(failed.status).not.toBe(0);
    expect(state(root, ["check", "--quiet", "HEAD"]).status).not.toBe(0);
  });
});

describe("Git verification guard", () => {
  it("blocks unverified branch and tag pushes but permits deletions", () => {
    const root = makeProject();
    const blocked = run(root, "bash", [
      ".githooks/pre-push",
      "origin",
      "example.test:stowplan.git",
    ], { input: prePushInput(root) });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("npm run verify:ready");

    record(root);
    const allowed = run(root, "bash", [
      ".githooks/pre-push",
      "origin",
      "example.test:stowplan.git",
    ], { input: prePushInput(root) });
    expect(allowed.status).toBe(0);

    git(root, ["tag", "-a", "verified", "-m", "verified"]);
    const tagObject = git(root, ["rev-parse", "refs/tags/verified"]);
    const tagPush = run(root, "bash", [
      ".githooks/pre-push",
      "origin",
      "example.test:stowplan.git",
    ], { input: prePushInput(root, tagObject) });
    expect(tagPush.status).toBe(0);

    const zero = "0".repeat(40);
    const deletion = run(root, "bash", [
      ".githooks/pre-push",
      "origin",
      "example.test:stowplan.git",
    ], {
      input: `refs/heads/main ${zero} refs/heads/main ${git(
        root,
        ["rev-parse", "HEAD"],
      )}\n`,
    });
    expect(deletion.status).toBe(0);
  });

  it("installs idempotently without replacing an unrelated hook", () => {
    const root = makeProject();
    const first = run(root, "bash", ["scripts/install-git-hooks.sh"]);
    requireSuccess(first, "install Git hook");
    const target = join(root, ".git/hooks/pre-push");
    expect(readFileSync(target, "utf8")).toBe(
      readFileSync(join(root, ".githooks/pre-push"), "utf8"),
    );
    expect(statSync(target).mode & 0o111).not.toBe(0);

    const second = run(root, "bash", ["scripts/install-git-hooks.sh"]);
    requireSuccess(second, "reinstall Git hook");

    writeFileSync(target, "#!/bin/bash\necho custom\n");
    const conflict = run(root, "bash", ["scripts/install-git-hooks.sh"]);
    expect(conflict.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("#!/bin/bash\necho custom\n");

    rmSync(target);
    const linkedHook = join(root, "linked-hook");
    writeFileSync(linkedHook, "#!/bin/bash\necho linked\n");
    symlinkSync(linkedHook, target);
    const symlinkConflict = run(root, "bash", ["scripts/install-git-hooks.sh"]);
    expect(symlinkConflict.status).not.toBe(0);
    expect(readFileSync(linkedHook, "utf8"))
      .toBe("#!/bin/bash\necho linked\n");
  });
});

describe("Codex verification guard", () => {
  it("blocks bypasses and unverified Stowplan pushes", () => {
    const root = makeProject();
    const payload = {
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command: "git push origin main" },
    };
    const unverified = hookOutput(hook(root, payload));
    expect(unverified).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(hookOutput(hook(root, {
      ...payload,
      tool_input: { command: "echo 'git push origin main'" },
    }))).toBeNull();

    record(root);
    expect(hookOutput(hook(root, payload))).toBeNull();
    const bypass = hookOutput(hook(root, {
      ...payload,
      tool_input: { command: "git push --no-verify origin main" },
    }));
    expect(bypass).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
  });

  it("continues premature readiness claims until the exact HEAD is verified", () => {
    const root = makeProject();
    const payload = {
      cwd: root,
      hook_event_name: "Stop",
      last_assistant_message: "The changes are ready to push.",
    };
    expect(hookOutput(hook(root, payload))).toMatchObject({ decision: "block" });
    expect(hookOutput(hook(root, {
      ...payload,
      last_assistant_message: "The changes are not ready to push.",
    }))).toBeNull();
    expect(hookOutput(hook(root, {
      ...payload,
      last_assistant_message: "Targeted tests pass, but the full gate has not run.",
    }))).toBeNull();

    record(root);
    expect(hookOutput(hook(root, payload))).toBeNull();

    writeFileSync(join(root, "fixture.txt"), "dirty\n");
    expect(hookOutput(hook(root, {
      ...payload,
      last_assistant_message: "Implemented and verified.",
    }))).toMatchObject({ decision: "block" });
  });
});
