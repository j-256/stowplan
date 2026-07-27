#!/bin/bash
# Produces the artifacts attached to a GitHub release.
#
# The SBOM lists production dependencies only, so it describes what actually
# ships rather than the build and test toolchain. The release step uploads this
# exact path, so keep the name in sync with the workflow.
#
# `npm sbom --omit=dev` cannot be used against this project directly. It selects
# `:root *:not(.dev)`, and npm marks a deduped package `.dev` when anything in
# devDependencies also reaches it -- so a direct production dependency shared
# with the docs or build toolchain is silently dropped. Here that omitted
# next, react, react-dom, and qrcode, leaving an SBOM that understated what
# ships. Generating from a tree resolved without devDependencies avoids the
# shared-node ambiguity entirely, so every production dependency is recorded.
set -euo pipefail

SBOM_PATH="stowplan-sbom.cdx.json"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

# npm names the SBOM root component after the directory rather than the
# manifest `name`, so resolve inside a directory named for the project
work_root="$(mktemp -d)"
trap 'rm -rf "${work_root}"' EXIT
work_dir="${work_root}/stowplan"
mkdir "${work_dir}"

echo "::group::cyclonedx sbom"
cp package.json package-lock.json "${work_dir}/"
# Resolve the same locked versions with the dev toolchain absent. --package-lock-only
# keeps this a metadata operation: nothing is downloaded and nothing is installed
node --input-type=module - "${work_dir}/package.json" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const path = process.argv[2];
const manifest = JSON.parse(await readFile(path, "utf8"));
delete manifest.devDependencies;
// Lifecycle scripts must not run for a metadata-only resolve
delete manifest.scripts;
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
# Run from inside the copy: npm resolves the tree relative to the working
# directory, so --prefix alone would still validate this project's node_modules
(
  cd "${work_dir}"
  npm install \
    --package-lock-only \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --silent
  npm sbom \
    --package-lock-only \
    --sbom-format cyclonedx
) > "${SBOM_PATH}"

# npm can exit 0 having written a diagnostic rather than a document, which would
# attach an unusable artifact. Assert the shape and that every declared
# production dependency is present, so a future dedup change cannot quietly
# shrink the SBOM again
node --input-type=module - "${SBOM_PATH}" package.json <<'NODE'
import { readFile } from "node:fs/promises";

const [, , sbomPath, manifestPath] = process.argv;
const document = JSON.parse(await readFile(sbomPath, "utf8"));
if (document.bomFormat !== "CycloneDX") {
  throw new Error(`${sbomPath} is not a CycloneDX document`);
}
const components = Array.isArray(document.components)
  ? document.components
  : [];
if (components.length === 0) {
  throw new Error(`${sbomPath} contains no components`);
}
const recorded = new Set(components.map((component) => component.name));
const declared = Object.keys(
  JSON.parse(await readFile(manifestPath, "utf8")).dependencies ?? {},
);
const missing = declared.filter((name) => !recorded.has(name));
if (missing.length > 0) {
  throw new Error(
    `${sbomPath} omits declared production dependencies: ${
      missing.join(", ")
    }`,
  );
}
console.log(
  `[release-artifacts] ${sbomPath}: ${components.length} components, all ${declared.length} declared production dependencies recorded`,
);
NODE
echo "::endgroup::"

echo "[release-artifacts] all artifacts written"
