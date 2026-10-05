import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIT_ADVISORY_URL =
  "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const AUDIT_PACKAGE = "braces";

export function reviewDependencyAudit(report, manifest) {
  const vulnerabilities = report?.vulnerabilities;
  const total = report?.metadata?.vulnerabilities?.total;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    return { ok: false, reason: "npm audit returned an unsupported report" };
  }

  const names = Object.keys(vulnerabilities);
  if (total === 0 && names.length === 0) {
    return { ok: true, exception: false };
  }
  if (total !== names.length) {
    return { ok: false, reason: "npm audit totals do not match its findings" };
  }

  const decisions = new Map();
  const review = (name, stack = new Set()) => {
    if (decisions.has(name)) return decisions.get(name);
    if (stack.has(name)) return false;
    const finding = vulnerabilities[name];
    if (!finding || !Array.isArray(finding.via) || finding.via.length === 0) {
      return false;
    }
    const nextStack = new Set(stack).add(name);
    const allowed = finding.via.every((source) => {
      if (typeof source === "string") return review(source, nextStack);
      return (
        source?.name === AUDIT_PACKAGE &&
        source?.dependency === AUDIT_PACKAGE &&
        source?.url === AUDIT_ADVISORY_URL
      );
    });
    decisions.set(name, allowed);
    return allowed;
  };

  if (!names.every((name) => review(name))) {
    return {
      ok: false,
      reason: "npm audit includes a finding outside the reviewed exception",
    };
  }

  const runtimeDependencies = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.optionalDependencies ?? {}),
  };
  const directFindings = names.filter(
    (name) => vulnerabilities[name]?.isDirect === true,
  );
  if (
    directFindings.length === 0 ||
    directFindings.some(
      (name) =>
        !(name in (manifest?.devDependencies ?? {})) ||
        name in runtimeDependencies,
    )
  ) {
    return {
      ok: false,
      reason: "the reviewed advisory reaches a runtime dependency",
    };
  }

  return { ok: true, exception: true };
}

function run() {
  const result = spawnSync("npm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error("Dependency audit did not return valid JSON");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const decision = reviewDependencyAudit(report, manifest);
  if (!decision.ok) {
    console.error(decision.reason);
    process.exitCode = 1;
    return;
  }
  if (decision.exception) {
    console.log(
      "Dependency audit accepted GHSA-vfj7-8cjw-p6xm only in reviewed development tooling; upstream has no patched release",
    );
    return;
  }
  if (result.status !== 0) {
    console.error("Dependency audit failed without a reported vulnerability");
    process.exitCode = 1;
    return;
  }
  console.log("Dependency audit found no vulnerabilities");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run();
}
